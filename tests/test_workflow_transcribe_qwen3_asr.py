"""Tests for besedy/workflows/transcribe_qwen3_asr.py."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

pytestmark = pytest.mark.optional_dependency
torch = pytest.importorskip("torch", reason="requires the optional ML extra")

from besedy.workflows import transcribe_qwen3_asr as transcribe_module  # noqa: E402
from besedy.workflows.transcribe_qwen3_asr import (  # noqa: E402
    QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT,
    QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT,
    QWEN3_SILERO_MIN_SPEECH_MS_DEFAULT,
    _build_sanitized_generation_config,
    _build_segments_from_words,
    _configure_generation_padding,
    _interpolated_words,
    _is_cuda_oom,
    _resolve_min_waveform_samples,
    _resolve_segmenter_mode,
    _should_drop_short_decode_segment,
    _split_segments_by_max_duration,
    ensure_audio_files,
    extract_vad_segments,
    load_audio_mono_16k,
    parse_args,
    resolve_bundle_root,
)
from tests.helpers.workflows import make_workflow_config  # noqa: E402


class TestParseArgs:
    """Tests for argument parsing."""

    def test_minimal_args(self):
        with patch("sys.argv", ["prog", "--audio", "/path/to/audio.wav"]):
            args = parse_args()
            assert args.audio == [Path("/path/to/audio.wav")]

    def test_custom_model_and_device(self):
        with patch(
            "sys.argv",
            [
                "prog",
                "--audio",
                "/path/to/audio.wav",
                "--model",
                "Qwen/Qwen3-ASR-1.7B",
                "--device",
                "cpu",
            ],
        ):
            args = parse_args()
            assert args.model == "Qwen/Qwen3-ASR-1.7B"
            assert args.device == "cpu"

    def test_no_word_timestamps_flag(self):
        with patch(
            "sys.argv",
            ["prog", "--audio", "/path/to/audio.wav", "--no-word-timestamps"],
        ):
            args = parse_args()
            assert args.word_timestamps is False

    def test_no_log_segments_flag(self):
        with patch(
            "sys.argv",
            ["prog", "--audio", "/path/to/audio.wav", "--no-log-segments"],
        ):
            args = parse_args()
            assert args.log_segments is False

    def test_custom_segmenter(self):
        with patch(
            "sys.argv",
            ["prog", "--audio", "/path/to/audio.wav", "--segmenter", "qwen-builtin"],
        ):
            args = parse_args()
            assert args.segmenter == "qwen-builtin"

    def test_default_min_silence_ms_is_qwen_default(self):
        with patch("sys.argv", ["prog", "--audio", "/path/to/audio.wav"]):
            args = parse_args()
            assert args.min_silence_ms == QWEN3_SILERO_MIN_SILENCE_MS_DEFAULT

    def test_default_min_speech_ms_is_qwen_default(self):
        with patch("sys.argv", ["prog", "--audio", "/path/to/audio.wav"]):
            args = parse_args()
            assert args.min_speech_ms == QWEN3_SILERO_MIN_SPEECH_MS_DEFAULT


def test_main_auto_language_records_detected_language_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / f"{'b' * 64}.wav"
    audio_path.touch()
    bundle_root = tmp_path / "bundle"
    bundle_root.mkdir()
    captured: dict[str, object] = {}

    class DummyAsrModel:
        def transcribe(self, *, audio: object, language: str | None, **_kwargs: object):
            captured["inference_language"] = language
            return [
                SimpleNamespace(
                    text="hello world",
                    language="English",
                    time_stamps=None,
                )
            ]

    default_config = SimpleNamespace(
        model_name="Qwen/Qwen3-ASR-1.7B",
        vad_model="silero_vad_v6",
        align_model=None,
        language="auto",
    )
    monkeypatch.setattr(
        transcribe_module,
        "select_transcription_workflow",
        lambda *_args, **_kwargs: default_config,
    )
    monkeypatch.setattr(
        transcribe_module,
        "resolve_bundle_root",
        lambda *_args, **_kwargs: bundle_root,
    )
    monkeypatch.setattr(
        transcribe_module,
        "_build_qwen_model",
        lambda **_kwargs: DummyAsrModel(),
    )
    monkeypatch.setattr(transcribe_module, "_configure_generation_padding", lambda _model: None)
    monkeypatch.setattr(transcribe_module, "_resolve_min_waveform_samples", lambda _model: 1)
    monkeypatch.setattr(
        transcribe_module,
        "load_audio_mono_16k",
        lambda _path: np.zeros(16000, dtype=np.float32),
    )
    monkeypatch.setattr(
        transcribe_module,
        "measure_audio_duration_seconds",
        lambda _path: 1.0,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prog",
            "--audio",
            str(audio_path),
            "--segmenter",
            "qwen-builtin",
            "--no-word-timestamps",
            "--no-log-segments",
            "--device",
            "cpu",
        ],
    )

    assert transcribe_module.main() == 0
    assert captured["inference_language"] is None

    output_path = bundle_root / ("b" * 64) / "transcript.json"
    generation_params = json.loads(output_path.read_text(encoding="utf-8"))["meta"][
        "generation_params"
    ]
    assert generation_params["requested_language"] == "auto"
    # Detected names from Qwen map back to ISO codes so metadata stays uniform.
    assert generation_params["detected_languages"] == ["en"]
    assert generation_params["language"] == "en"


class TestEnsureAudioFiles:
    """Tests for audio file validation."""

    def test_existing_files_resolved(self, tmp_path):
        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        result = ensure_audio_files([audio_file])
        assert len(result) == 1
        assert result[0].is_absolute()
        assert result[0].exists()

    def test_missing_file_raises(self, tmp_path):
        missing = tmp_path / "missing.wav"
        with pytest.raises(FileNotFoundError, match="Audio file not found"):
            ensure_audio_files([missing])


class TestLoadAudioMono16k:
    """Tests for staged audio loading."""

    def test_loads_mono_16k(self, tmp_path, monkeypatch):
        audio_path = tmp_path / "audio.wav"
        audio_path.touch()
        waveform = np.zeros(16000, dtype=np.float32)

        monkeypatch.setattr(
            "besedy.workflows.transcribe_qwen3_asr.sf.read",
            lambda *args, **kwargs: (waveform, 16000),
        )

        loaded = load_audio_mono_16k(audio_path)
        assert isinstance(loaded, np.ndarray)
        assert loaded.shape == (16000,)

    def test_rejects_non_16k_audio(self, tmp_path, monkeypatch):
        audio_path = tmp_path / "audio.wav"
        audio_path.touch()

        monkeypatch.setattr(
            "besedy.workflows.transcribe_qwen3_asr.sf.read",
            lambda *args, **kwargs: (np.zeros(8000, dtype=np.float32), 8000),
        )

        with pytest.raises(ValueError, match="Expected staged audio at 16000Hz"):
            load_audio_mono_16k(audio_path)


class TestResolveBundleRoot:
    """Tests for output directory resolution."""

    @staticmethod
    def _patch_configured_workflow(monkeypatch):
        monkeypatch.setattr(
            "besedy.workflows.transcribe_qwen3_asr.select_transcription_workflow",
            lambda *_args, **_kwargs: make_workflow_config(
                workflow_id="qwen3-asr",
                workflow_label="qwen3-asr",
                model_name="Qwen/Qwen3-ASR-1.7B",
            ),
        )

    def test_default_output_dir(self, tmp_path, monkeypatch):
        self._patch_configured_workflow(monkeypatch)
        monkeypatch.setattr(
            "besedy.workflows.transcribe_qwen3_asr.resolve_transcripts_root",
            lambda x=None: tmp_path / "transcripts",
        )

        result = resolve_bundle_root(
            None, model_name="Qwen/Qwen3-ASR-1.7B", vad_model="silero_vad_v6", language="cs"
        )
        assert "qwen3-asr" in str(result)
        assert result.exists()

    def test_custom_output_dir(self, tmp_path, monkeypatch):
        custom_dir = tmp_path / "custom_output"
        custom_dir.mkdir()

        self._patch_configured_workflow(monkeypatch)
        monkeypatch.setattr(
            "besedy.workflows.transcribe_qwen3_asr.resolve_project_path",
            lambda x: Path(x).expanduser().resolve(),
        )

        result = resolve_bundle_root(
            custom_dir, model_name="Qwen/Qwen3-ASR-1.7B", vad_model="silero", language="cs"
        )
        assert str(custom_dir) in str(result)


class TestInterpolatedWords:
    """Tests for fallback word timing interpolation."""

    def test_interpolates_word_timing(self):
        words = _interpolated_words("ahoj svete", 1.0, 3.0)
        assert len(words) == 2
        assert words[0]["word"] == "ahoj"
        assert words[1]["word"] == "svete"
        assert words[0]["start"] == 1.0
        assert words[-1]["end"] == 3.0

    def test_empty_text_returns_empty(self):
        assert _interpolated_words("", 0.0, 1.0) == []


class TestExtractVadSegments:
    """Tests for Silero VAD bridging helpers."""

    def test_converts_numpy_audio_to_torch_tensor(self, monkeypatch):
        seen: dict[str, object] = {}

        def fake_get_speech_timestamps(audio, vad_model, **kwargs):
            seen["is_tensor"] = isinstance(audio, torch.Tensor)
            seen["dtype"] = audio.dtype
            seen["vad_model"] = vad_model
            seen["kwargs"] = kwargs
            return [{"start": 1600, "end": 3200}]

        monkeypatch.setitem(
            sys.modules,
            "silero_vad",
            SimpleNamespace(get_speech_timestamps=fake_get_speech_timestamps),
        )

        segments = extract_vad_segments(
            np.zeros(32000, dtype=np.float32),
            vad_model="vad-model",
            min_silence_duration_ms=500,
            min_speech_duration_ms=250,
            speech_threshold=0.6,
            sample_rate=16000,
        )

        assert seen["is_tensor"] is True
        assert seen["dtype"] == torch.float32
        assert seen["vad_model"] == "vad-model"
        assert seen["kwargs"] == {
            "sampling_rate": 16000,
            "min_silence_duration_ms": 500,
            "min_speech_duration_ms": 250,
            "threshold": 0.6,
        }
        assert segments == [{"start": 0.1, "end": 0.2}]


class TestConfigureGenerationPadding:
    """Tests for pad_token_id generation config setup."""

    def test_sets_pad_token_id_from_eos(self):
        generation_config = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        model_config = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        model = SimpleNamespace(generation_config=generation_config, config=model_config)
        asr_model = SimpleNamespace(model=model)

        _configure_generation_padding(asr_model)

        assert generation_config.pad_token_id == 151645
        assert model_config.pad_token_id == 151645

    def test_sets_pad_token_on_thinker(self):
        thinker_gen = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        thinker_cfg = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        thinker = SimpleNamespace(generation_config=thinker_gen, config=thinker_cfg)
        model = SimpleNamespace(generation_config=None, thinker=thinker)
        asr_model = SimpleNamespace(model=model)

        _configure_generation_padding(asr_model)

        assert thinker_gen.pad_token_id == 151645
        assert thinker_cfg.pad_token_id == 151645

    def test_sets_pad_token_for_model_and_nested_generators(self):
        model_gen = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        model_cfg = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        thinker_gen = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        thinker_cfg = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        talker_gen = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        talker_cfg = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        thinker = SimpleNamespace(generation_config=thinker_gen, config=thinker_cfg)
        talker = SimpleNamespace(generation_config=talker_gen, config=talker_cfg)
        model = SimpleNamespace(
            generation_config=model_gen,
            config=model_cfg,
            thinker=thinker,
            talker=talker,
        )
        asr_model = SimpleNamespace(model=model)

        _configure_generation_padding(asr_model)

        assert model_gen.pad_token_id == 151645
        assert model_cfg.pad_token_id == 151645
        assert thinker_gen.pad_token_id == 151645
        assert thinker_cfg.pad_token_id == 151645
        assert talker_gen.pad_token_id == 151645
        assert talker_cfg.pad_token_id == 151645

    def test_nullifies_temperature_for_greedy_decode(self):
        generation_config = SimpleNamespace(
            pad_token_id=151643,
            eos_token_id=151645,
            do_sample=False,
            temperature=1e-06,
        )
        model = SimpleNamespace(generation_config=generation_config, config=SimpleNamespace())
        asr_model = SimpleNamespace(model=model)

        _configure_generation_padding(asr_model)

        assert generation_config.temperature is None

    def test_keeps_temperature_when_sampling_enabled(self):
        generation_config = SimpleNamespace(
            pad_token_id=151643,
            eos_token_id=151645,
            do_sample=True,
            temperature=0.2,
        )
        model = SimpleNamespace(generation_config=generation_config, config=SimpleNamespace())
        asr_model = SimpleNamespace(model=model)

        _configure_generation_padding(asr_model)

        assert generation_config.temperature == 0.2

    def test_uses_processor_tokenizer_pad_token_id_fallback(self):
        generation_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model = SimpleNamespace(generation_config=generation_config, config=model_config)
        tokenizer = SimpleNamespace(pad_token_id=151643, eos_token_id=151645)
        processor = SimpleNamespace(tokenizer=tokenizer)
        asr_model = SimpleNamespace(model=model, processor=processor)

        _configure_generation_padding(asr_model)

        assert generation_config.pad_token_id == 151643
        assert model_config.pad_token_id == 151643

    def test_uses_processor_tokenizer_eos_when_pad_missing(self):
        generation_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model = SimpleNamespace(generation_config=generation_config, config=model_config)
        tokenizer = SimpleNamespace(pad_token_id=None, eos_token_id=151645)
        processor = SimpleNamespace(tokenizer=tokenizer)
        asr_model = SimpleNamespace(model=model, processor=processor)

        _configure_generation_padding(asr_model)

        assert generation_config.pad_token_id == 151645
        assert model_config.pad_token_id == 151645

    def test_logs_warning_when_pad_token_cannot_be_inferred(self, caplog):
        generation_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model_config = SimpleNamespace(pad_token_id=None, eos_token_id=None)
        model = SimpleNamespace(generation_config=generation_config, config=model_config)
        asr_model = SimpleNamespace(
            model=model, processor=SimpleNamespace(tokenizer=SimpleNamespace())
        )

        with caplog.at_level(logging.WARNING):
            _configure_generation_padding(asr_model)

        assert "Qwen3-ASR generation pad_token_id could not be inferred" in caplog.text


class TestBuildSanitizedGenerationConfig:
    """Tests for preloading and sanitizing generation config."""

    def test_nullifies_temperature_for_greedy_decode(self, monkeypatch):
        class FakeAutoConfig:
            @staticmethod
            def from_pretrained(_: str):
                return {"model_type": "qwen3_asr"}

        class FakeGenerationConfig:
            @staticmethod
            def from_model_config(_: object):
                return SimpleNamespace(do_sample=False, temperature=1e-06)

        monkeypatch.setitem(
            sys.modules,
            "transformers",
            SimpleNamespace(
                AutoConfig=FakeAutoConfig,
                GenerationConfig=FakeGenerationConfig,
            ),
        )

        generation_config = _build_sanitized_generation_config("Qwen/Qwen3-ASR-1.7B")

        assert generation_config is not None
        assert generation_config.temperature is None

    def test_keeps_temperature_when_sampling_enabled(self, monkeypatch):
        class FakeAutoConfig:
            @staticmethod
            def from_pretrained(_: str):
                return {"model_type": "qwen3_asr"}

        class FakeGenerationConfig:
            @staticmethod
            def from_model_config(_: object):
                return SimpleNamespace(do_sample=True, temperature=0.2)

        monkeypatch.setitem(
            sys.modules,
            "transformers",
            SimpleNamespace(
                AutoConfig=FakeAutoConfig,
                GenerationConfig=FakeGenerationConfig,
            ),
        )

        generation_config = _build_sanitized_generation_config("Qwen/Qwen3-ASR-1.7B")

        assert generation_config is not None
        assert generation_config.temperature == 0.2

    def test_returns_none_if_config_load_fails(self, monkeypatch):
        class FakeAutoConfig:
            @staticmethod
            def from_pretrained(_: str):
                raise RuntimeError("load failed")

        class FakeGenerationConfig:
            @staticmethod
            def from_model_config(_: object):
                return SimpleNamespace(do_sample=False, temperature=1e-06)

        monkeypatch.setitem(
            sys.modules,
            "transformers",
            SimpleNamespace(
                AutoConfig=FakeAutoConfig,
                GenerationConfig=FakeGenerationConfig,
            ),
        )

        assert _build_sanitized_generation_config("Qwen/Qwen3-ASR-1.7B") is None


class TestCudaOomDetection:
    """Tests for CUDA OOM exception detection helper."""

    def test_detects_oom_message(self):
        exc = RuntimeError("CUDA out of memory. Tried to allocate 1.0 GiB")
        assert _is_cuda_oom(exc) is True

    def test_non_oom_is_false(self):
        exc = RuntimeError("Something else happened")
        assert _is_cuda_oom(exc) is False


class TestSegmenterResolution:
    """Tests for automatic segmenter mode selection."""

    def test_auto_prefers_silero_when_timestamps_active(self):
        result = _resolve_segmenter_mode(
            requested="auto",
            request_timestamps=True,
            vad_filter_enabled=True,
        )
        assert result == "silero-vad"

    def test_auto_uses_silero_without_timestamps(self):
        result = _resolve_segmenter_mode(
            requested="auto",
            request_timestamps=False,
            vad_filter_enabled=True,
        )
        assert result == "silero-vad"


class TestSplitSegmentsByMaxDuration:
    """Tests for proactive segment splitting by duration."""

    def test_splits_long_segment(self):
        segments = _split_segments_by_max_duration(
            [{"start": 0.0, "end": 200.0}],
            max_segment_seconds=90.0,
        )
        assert len(segments) == 3
        assert segments[0] == {"start": 0.0, "end": 90.0}
        assert segments[1] == {"start": 90.0, "end": 180.0}
        assert segments[2] == {"start": 180.0, "end": 200.0}


class TestShortSegmentWaveformGuards:
    """Tests for tiny waveform safeguards used by silero segment decode."""

    def test_resolve_min_waveform_samples_from_n_fft(self):
        asr_model = SimpleNamespace(
            processor=SimpleNamespace(feature_extractor=SimpleNamespace(n_fft=400))
        )
        assert _resolve_min_waveform_samples(asr_model) == 201

    def test_resolve_min_waveform_samples_defaults_without_feature_extractor(self):
        asr_model = SimpleNamespace(processor=None)
        assert _resolve_min_waveform_samples(asr_model) == QWEN3_ASR_MIN_WAVEFORM_SAMPLES_DEFAULT

    def test_should_drop_short_decode_segment(self):
        assert _should_drop_short_decode_segment(num_samples=200, min_samples=201) is True
        assert _should_drop_short_decode_segment(num_samples=201, min_samples=201) is False
        assert _should_drop_short_decode_segment(num_samples=256, min_samples=201) is False


class TestBuildSegmentsFromWords:
    """Tests for segment building from aligned words."""

    def test_splits_on_large_gap(self):
        words = [
            {"start": 0.0, "end": 0.3, "word": "ahoj", "confidence": None},
            {"start": 0.35, "end": 0.6, "word": "svete", "confidence": None},
            {"start": 2.0, "end": 2.2, "word": "dalsi", "confidence": None},
        ]
        segments = _build_segments_from_words(words, max_gap_s=0.8, max_duration_s=30.0)
        assert len(segments) == 2
        assert segments[0]["text"] == "ahoj svete"
        assert segments[1]["text"] == "dalsi"
