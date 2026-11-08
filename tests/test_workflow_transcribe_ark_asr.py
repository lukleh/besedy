"""Protocol and long-recording artifact contracts for optional ARK-ASR."""

from __future__ import annotations

import contextlib
import json
import sys
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from besedy.lib.workflow.config import WorkflowConfig
from besedy.workflows import transcribe_ark_asr as ark


@pytest.fixture
def workflow():
    return WorkflowConfig(
        workflow_id="ark-asr",
        workflow_type="transcription",
        workflow_label="ark-asr",
        model_name=ark.MODEL_ID,
        vad_model="silero_vad_v6",
        language="cs",
        align_model="comodoro/wav2vec2-xls-r-300m-cs-250",
    )


@pytest.fixture
def audio_path(tmp_path):
    path = tmp_path / ("a" * 64 + ".wav")
    path.write_bytes(b"staged audio")
    return path


def test_vad_splits_long_speech_without_losing_offsets_or_gaps():
    regions = [
        {"start": ark.SAMPLE_RATE, "end": 67 * ark.SAMPLE_RATE},
        {"start": 70 * ark.SAMPLE_RATE, "end": 71 * ark.SAMPLE_RATE},
    ]
    assert ark.bounded_regions(regions, 80 * ark.SAMPLE_RATE) == [
        (ark.SAMPLE_RATE, 31 * ark.SAMPLE_RATE),
        (31 * ark.SAMPLE_RATE, 61 * ark.SAMPLE_RATE),
        (61 * ark.SAMPLE_RATE, 67 * ark.SAMPLE_RATE),
        (70 * ark.SAMPLE_RATE, 71 * ark.SAMPLE_RATE),
    ]


@pytest.mark.parametrize(
    "regions",
    [
        [{"start": -1, "end": 500}],
        [{"start": 0, "end": 1001}],
        [{"start": 0, "end": 500}, {"start": 499, "end": 800}],
    ],
)
def test_bad_vad_bounds_are_rejected_before_decode(regions):
    with pytest.raises(ValueError, match="VAD region"):
        ark.bounded_regions(regions, 1000)


def test_hub_revisions_are_immutable_and_local_models_are_explicit(tmp_path):
    assert ark.model_revision(ark.MODEL_ID) == ark.MODEL_REVISION
    assert ark.model_revision("owner/finetuned", "b" * 40) == "b" * 40
    assert ark.model_revision(str(tmp_path)) == "local"
    for revision in (None, "main", "45776"):
        with pytest.raises(ValueError, match="40-character commit"):
            ark.model_revision("owner/finetuned", revision)


def fake_tokenizer():
    return SimpleNamespace(
        eos_token_id=2,
        unk_token_id=0,
        pad_token_id=1,
        all_special_ids=[1, 2, 3, 4],
        added_tokens_decoder={
            5: SimpleNamespace(content="<|text|>"),
            6: SimpleNamespace(content="ordinary"),
        },
        convert_tokens_to_ids=lambda marker: {"<|user|>": 3, "<|assistant|>": 4, "<|im_end|>": 2}[
            marker
        ],
    )


def test_special_token_mask_keeps_real_eos_but_blocks_control_turn_stops():
    model = SimpleNamespace(
        config=SimpleNamespace(eos_token_id=2), generation_config=SimpleNamespace(eos_token_id=[2])
    )
    eos, blocked = ark.generation_token_ids(model, fake_tokenizer())
    assert eos == [2, 3, 4]
    scores = np.zeros((1, ark.AUDIO_TOKEN_START + 5))
    mask = ark.ASRTokenMask([*blocked, -1, ark.AUDIO_TOKEN_START, ark.AUDIO_TOKEN_START + 4])
    assert mask.blocked == blocked
    mask(None, scores)
    assert np.isneginf(scores[0, 1])
    assert np.isneginf(scores[0, 5])
    assert np.isneginf(scores[0, [3, 4]]).all()
    assert np.isneginf(scores[0, ark.AUDIO_TOKEN_START :]).all()
    assert (scores[0, [2, 6]] == 0).all()


def test_upstream_output_cleanup_removes_control_tokens_and_next_turn():
    text = "<|text|> , Dobrý\n den. <|bicodec_semantic_5|><|end_content|><|user|>ignored"
    assert ark.normalize_prediction(text) == "Dobrý den."


class Tensor(np.ndarray):
    def __new__(cls, values):
        return np.asarray(values).view(cls)

    def to(self, *args, **kwargs):
        return self


def install_fake_torch(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(
            float16="float16",
            float32="float32",
            is_tensor=lambda value: isinstance(value, Tensor),
            ones_like=lambda value: Tensor(np.ones_like(value)),
            as_tensor=lambda value: value,
            inference_mode=contextlib.nullcontext,
        ),
    )


def test_generation_uses_audio_prompt_and_slices_input_before_text_decode(monkeypatch):
    install_fake_torch(monkeypatch)
    tokenizer = fake_tokenizer()
    tokenizer.decode = Mock(return_value="<|text|> Dobrý den.<|im_end|>")
    processor = SimpleNamespace(
        apply_chat_template=Mock(
            return_value={
                "input_ids": Tensor([[99, 98, 97]]),
                "audios": Tensor([[[0.1]]]),
            }
        )
    )
    generate = Mock(return_value=Tensor([[99, 98, 97, 10, 11, 2]]))
    model = SimpleNamespace(
        config=SimpleNamespace(eos_token_id=2),
        generation_config=SimpleNamespace(eos_token_id=2),
        generate=generate,
    )
    runtime = ark.ArkRuntime(model, processor, tokenizer, "cpu", "float32", ark.MODEL_REVISION)
    waveform = np.zeros(16000, dtype=np.float32)
    assert ark.transcribe_chunk(runtime, waveform) == "Dobrý den."
    prompt = processor.apply_chat_template.call_args.args[0][0][0]["content"]
    assert prompt[0]["array"] is waveform
    assert prompt[1] == {"type": "text", "text": "Please transcribe this audio."}
    assert tokenizer.decode.call_args.args[0].tolist() == [10, 11, 2]
    kwargs = generate.call_args.kwargs
    assert kwargs["do_sample"] is False
    assert kwargs["use_cache"] is True
    assert kwargs["attention_mask"].tolist() == [[1, 1, 1]]
    assert kwargs["max_new_tokens"] == ark.MAX_NEW_TOKENS


def test_token_limit_failure_is_not_silently_accepted(monkeypatch):
    install_fake_torch(monkeypatch)
    monkeypatch.setattr(ark, "MAX_NEW_TOKENS", 3)
    model = SimpleNamespace(
        config=SimpleNamespace(eos_token_id=2),
        generation_config=SimpleNamespace(eos_token_id=2),
        generate=lambda **kwargs: Tensor([[99, 10, 11, 12]]),
    )
    processor = SimpleNamespace(
        apply_chat_template=lambda *args, **kwargs: {
            "input_ids": Tensor([[99]]),
            "audios": Tensor([[[0.1]]]),
        }
    )
    runtime = ark.ArkRuntime(
        model, processor, fake_tokenizer(), "cpu", "float32", ark.MODEL_REVISION
    )
    with pytest.raises(RuntimeError, match="token limit"):
        ark.transcribe_chunk(runtime, np.zeros(16000))


def test_model_processor_and_tokenizer_load_from_same_pinned_local_snapshot(monkeypatch, tmp_path):
    install_fake_torch(monkeypatch)
    snapshot = Mock(return_value=str(tmp_path))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=snapshot))
    tokenizer = fake_tokenizer()
    processor = SimpleNamespace(tokenizer=fake_tokenizer())
    model = SimpleNamespace(to=Mock(), eval=Mock())
    model.to.return_value = model
    model.eval.return_value = model
    factories = [
        SimpleNamespace(from_pretrained=Mock(return_value=value))
        for value in (model, processor, tokenizer)
    ]
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            AutoModelForCausalLM=factories[0],
            AutoProcessor=factories[1],
            AutoTokenizer=factories[2],
        ),
    )
    runtime = ark.load_model(ark.MODEL_ID, "cpu", ark.MODEL_REVISION)
    snapshot.assert_called_once_with(ark.MODEL_ID, revision=ark.MODEL_REVISION)
    assert runtime.revision == ark.MODEL_REVISION
    for factory in factories:
        assert factory.from_pretrained.call_args.args == (str(tmp_path),)
        assert factory.from_pretrained.call_args.kwargs["trust_remote_code"] is True
    assert tokenizer.padding_side == processor.tokenizer.padding_side == "left"


def install_fake_audio(monkeypatch):
    install_fake_torch(monkeypatch)
    waveform = np.zeros(80 * ark.SAMPLE_RATE, dtype=np.float32)
    monkeypatch.setitem(
        sys.modules,
        "soundfile",
        SimpleNamespace(
            info=lambda path: SimpleNamespace(samplerate=ark.SAMPLE_RATE, channels=1),
            read=lambda path, **kwargs: (waveform, ark.SAMPLE_RATE),
        ),
    )
    timestamps = Mock(
        return_value=[
            {"start": ark.SAMPLE_RATE, "end": 67 * ark.SAMPLE_RATE},
            {"start": 70 * ark.SAMPLE_RATE, "end": 71 * ark.SAMPLE_RATE},
        ]
    )
    monkeypatch.setitem(
        sys.modules, "silero_vad", SimpleNamespace(get_speech_timestamps=timestamps)
    )
    monkeypatch.setattr(
        ark,
        "config",
        SimpleNamespace(vad=SimpleNamespace(filter_enabled=True, min_silence_ms=None)),
    )
    return timestamps


def test_full_file_outputs_raw_offsets_and_honest_provenance_without_completion_marker(
    monkeypatch, tmp_path, audio_path, workflow
):
    timestamps = install_fake_audio(monkeypatch)
    decode = Mock(side_effect=["one", "two", "", "four"])
    monkeypatch.setattr(ark, "transcribe_chunk", decode)
    runtime = ark.ArkRuntime(None, None, None, "cpu", "float32", ark.MODEL_REVISION)
    output = ark.resolve_bundle_root(tmp_path / "ark-asr", workflow)
    payload = ark.transcribe_file(
        audio_path, runtime=runtime, vad=object(), workflow=workflow, output=output
    )
    target = output / audio_path.stem
    assert json.loads((target / ark.RAW_FILENAME).read_text()) == payload
    assert not (target / "transcript.json").exists()
    assert [(s["start"], s["end"]) for s in payload["segments"]] == [(1, 31), (31, 61), (70, 71)]
    assert [len(call.args[1]) for call in decode.call_args_list] == [480000, 480000, 96000, 16000]
    assert all(set(s) == {"start", "end", "text"} for s in payload["segments"])
    assert payload["meta"]["generation_params"]["asr_language"] == "auto"
    assert payload["meta"]["generation_params"]["alignment_language"] == "cs"
    assert payload["meta"]["duration"] == 80
    assert timestamps.call_args.kwargs["max_speech_duration_s"] == 30
    assert ark.raw_is_complete(target / ark.RAW_FILENAME, audio_path, workflow, ark.MODEL_REVISION)
    assert not ark.raw_is_complete(
        target / ark.RAW_FILENAME, audio_path, replace(workflow, language="en"), ark.MODEL_REVISION
    )
    assert not ark.raw_is_complete(target / ark.RAW_FILENAME, audio_path, workflow, "b" * 40)


def test_decode_failure_never_publishes_raw_completion(monkeypatch, tmp_path, audio_path, workflow):
    install_fake_audio(monkeypatch)
    decode = Mock(side_effect=["first", RuntimeError("decode failed")])
    monkeypatch.setattr(ark, "transcribe_chunk", decode)
    runtime = ark.ArkRuntime(None, None, None, "cpu", "float32", ark.MODEL_REVISION)
    with pytest.raises(RuntimeError, match="decode failed"):
        ark.transcribe_file(
            audio_path, runtime=runtime, vad=object(), workflow=workflow, output=tmp_path
        )
    assert not (tmp_path / audio_path.stem / ark.RAW_FILENAME).exists()
    assert decode.call_count == 2


def test_skip_existing_raw_is_checked_before_loading_any_models(
    monkeypatch, tmp_path, audio_path, workflow
):
    monkeypatch.setattr(ark, "select_transcription_workflow", lambda *args, **kwargs: workflow)
    monkeypatch.setattr(ark, "raw_is_complete", lambda *args: True)
    load = Mock(side_effect=AssertionError("must not load ARK"))
    monkeypatch.setattr(ark, "load_model", load)
    assert (
        ark.main(["--audio", str(audio_path), "--output-dir", str(tmp_path), "--skip-existing"])
        == 0
    )
    load.assert_not_called()


@pytest.mark.parametrize(
    "overrides, message",
    [
        (["--language", "auto"], "concrete language"),
        (["--align-model", ""], "requires align_model"),
        (["--align-model", "   "], "requires align_model"),
    ],
)
def test_cli_validates_effective_alignment_overrides_before_loading(
    monkeypatch, audio_path, workflow, overrides, message
):
    monkeypatch.setattr(ark, "select_transcription_workflow", lambda *args, **kwargs: workflow)
    load = Mock(side_effect=AssertionError("must reject before loading"))
    monkeypatch.setattr(ark, "load_model", load)
    with pytest.raises(ValueError, match=message):
        ark.main(["--audio", str(audio_path), *overrides])
    load.assert_not_called()


def test_ark_sample_rate_contract_does_not_follow_a_different_audio_config(
    monkeypatch, tmp_path, audio_path, workflow
):
    from besedy.config import settings

    install_fake_audio(monkeypatch)
    monkeypatch.setattr(
        settings, "config", SimpleNamespace(audio=SimpleNamespace(sample_rate=8000))
    )
    sys.modules["soundfile"].info = lambda path: SimpleNamespace(samplerate=8000, channels=1)
    runtime = ark.ArkRuntime(None, None, None, "cpu", "float32", ark.MODEL_REVISION)
    with pytest.raises(ValueError, match="requires 16000 Hz"):
        ark.transcribe_file(
            audio_path, runtime=runtime, vad=None, workflow=workflow, output=tmp_path
        )


@pytest.mark.parametrize("params", [None, [], 1, "invalid"])
def test_corrupt_cached_generation_parameters_trigger_regeneration(
    tmp_path, audio_path, workflow, params
):
    target = tmp_path / ark.RAW_FILENAME
    target.write_text(json.dumps({"meta": {"generation_params": params}}))
    assert not ark.raw_is_complete(target, audio_path, workflow, ark.MODEL_REVISION)
