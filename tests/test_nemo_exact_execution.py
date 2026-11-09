"""Exercise the real process argv and NeMo startup without loading ML models."""

from __future__ import annotations

import importlib.util
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from besedy.lib.audio.types import PreparedEntry
from besedy.lib.workflow.paths import path_builder
from besedy.lib.workflow.runner import TranscriptionJob, WorkflowRunConfig, build_workflows
from tests.helpers.workflows import make_workflow_config


@pytest.fixture
def nemo_module(monkeypatch):
    # Stub only imports owned by the optional ML environment. Parsing, config
    # selection, path construction and main's model setup remain real code.
    path = Path(__file__).parents[1] / "besedy/workflows/transcribe_nemo.py"
    spec = importlib.util.spec_from_file_location("nemo_execution_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    with monkeypatch.context() as imports:
        for name in (
            "torch",
            "besedy.lib.nemo",
            "besedy.lib.nemo.segments",
            "besedy.lib.nemo.vad",
        ):
            imports.setitem(sys.modules, name, MagicMock())
        spec.loader.exec_module(module)
    return module


class StopBeforeInference(Exception):
    pass


def capture_model_setup(nemo_module, monkeypatch):
    calls = {}
    monkeypatch.setattr(nemo_module, "resolve_device", lambda _: "cpu")

    def load_vad(model, device):
        calls["vad"] = (model, device)
        return SimpleNamespace(eval=lambda: None)

    def load_asr(model, device, **kwargs):
        calls["asr"] = (model, device, kwargs)
        raise StopBeforeInference

    monkeypatch.setattr(nemo_module, "load_frame_vad", load_vad)
    monkeypatch.setattr(nemo_module, "load_asr", load_asr)
    return calls


@pytest.mark.parametrize("strategy", [None, "greedy", "beam"])
def test_selected_variant_survives_builder_parser_and_startup(
    nemo_module, monkeypatch, tmp_path, strategy
):
    workflow_id = "canary-nemo-beam" if strategy == "beam" else "canary-nemo"
    first = make_workflow_config(
        workflow_id=workflow_id,
        workflow_label=workflow_id,
        model_name="same-model",
        vad_model="vad-A",
        align_model="align-A" if strategy == "beam" else None,
        decode_strategy=strategy,
    )
    selected = replace(
        first, vad_model="vad-B", align_model="align-B" if strategy == "beam" else None
    )
    monkeypatch.setattr(
        "besedy.lib.workflow.config.get_transcription_workflows", lambda **_: [first, selected]
    )
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime._docker_runtime_ready", lambda **_: (True, None)
    )
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    audio_hash = "a" * 64
    audio = tmp_path / f"{audio_hash}.wav"
    audio.touch()
    output_root = tmp_path / "transcripts"
    workflows = build_workflows(
        [PreparedEntry(audio_hash, audio, audio, "existing", 1)],
        WorkflowRunConfig(output_root=output_root, nemo_parallel=1),
        transcription_jobs=[
            TranscriptionJob(selected, {audio_hash}, {audio_hash} if strategy == "beam" else set())
        ],
        hashes_for_pyannote_diarization=set(),
    )
    argv = list(workflows[0].argv)
    script_index = next(i for i, arg in enumerate(argv) if arg.endswith("/transcribe_nemo.py"))
    monkeypatch.setattr(sys, "argv", argv[script_index:])
    parsed = nemo_module.parse_arguments()
    assert parsed.workflow_config == selected
    assert parsed.vad_model == selected.vad_model
    assert parsed.decode_strategy == (strategy or "greedy")
    assert parsed.source_lang == parsed.target_lang == selected.language
    # The beam alignment process must read the exact directory NeMo writes.
    selected_directory = path_builder(selected).workflow_dir(output_root)
    if strategy == "beam":
        align_argv = list(workflows[1].argv)
        assert str(selected_directory / audio_hash / "nemo_beam_segments.json") in align_argv
        assert align_argv[align_argv.index("--align-model") + 1] == selected.align_model

    def unexpected_selection(*_, **__):
        pytest.fail("an exact execution must not select a configured sibling again")

    monkeypatch.setattr(nemo_module, "select_transcription_workflow", unexpected_selection)
    calls = capture_model_setup(nemo_module, monkeypatch)
    with pytest.raises(StopBeforeInference):
        nemo_module.main()
    assert selected_directory.is_dir()
    assert not path_builder(first).workflow_dir(output_root).exists()
    assert calls["vad"] == (selected.vad_model, "cpu")
    assert calls["asr"][0] == selected.model_name
    assert calls["asr"][2]["decode_strategy"] == (strategy or "greedy")


def test_standalone_nemo_keeps_config_selection_and_cli_overrides(
    nemo_module, monkeypatch, tmp_path
):
    configured = make_workflow_config(
        workflow_id="canary-nemo", workflow_label="custom-label", decode_strategy="greedy"
    )
    selections = []
    monkeypatch.setattr(
        nemo_module,
        "select_transcription_workflow",
        lambda *args, **kwargs: selections.append((args, kwargs)) or configured,
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "transcribe_nemo.py",
            "--model",
            "override-model",
            "--vad-model",
            "override-vad",
            "--source-lang",
            "en",
            "--target-lang",
            "cs",
            "--output-dir",
            str(tmp_path),
        ],
    )
    calls = capture_model_setup(nemo_module, monkeypatch)
    with pytest.raises(StopBeforeInference):
        nemo_module.main()
    assert selections == [(("canary-nemo",), {"model_name": "override-model", "language": "cs"})]
    assert calls["vad"] == ("override-vad", "cpu")
    assert calls["asr"][0] == "override-model"
    assert calls["asr"][2]["decode_strategy"] == "greedy"


@pytest.mark.parametrize(
    "value", ["not-json", "[]", "{}", json.dumps(asdict(make_workflow_config()))]
)
def test_invalid_or_non_nemo_internal_config_is_rejected(nemo_module, monkeypatch, value):
    monkeypatch.setattr(sys, "argv", ["transcribe_nemo.py", "--workflow-config", value])
    with pytest.raises(SystemExit) as error:
        nemo_module.parse_arguments()
    assert error.value.code == 2
