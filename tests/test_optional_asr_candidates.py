"""Integration boundaries for opt-in transcription candidates."""

from pathlib import Path

import pytest

import besedy.config.settings as config_settings
from besedy.core.paths import PROJECT_ROOT
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.runtime.backend_runtime import build_python_backend_process
from besedy.lib.workflow.config import get_transcription_workflows
from besedy.lib.workflow.runner import TranscriptionJob, WorkflowRunConfig, build_workflows


@pytest.fixture
def example_workflows(monkeypatch):
    monkeypatch.setenv("BESEDY_CONFIG", str(PROJECT_ROOT / "besedy.toml.example"))
    monkeypatch.setattr(config_settings, "_CONFIG", None)
    return get_transcription_workflows()


def test_new_candidates_are_explicit_only(example_workflows):
    candidates = [
        config
        for config in example_workflows
        if config.workflow_id == "nemo-rnnt" or config.model_name.endswith("/czechspeech-ct2")
    ]
    assert len(candidates) == 2
    assert all(not c.pipeline_default and not c.expected_default for c in candidates)
    assert not any(c in get_transcription_workflows(pipeline_only=True) for c in candidates)
    assert not any(c in get_transcription_workflows(expected_only=True) for c in candidates)
    czech = next(c for c in candidates if c.workflow_id == "whisperx")
    assert czech.align_model == "comodoro/wav2vec2-xls-r-300m-cs-250"
    assert czech.language == "cs"


def test_rnnt_uses_its_own_docker_runtime_and_selected_audio(
    example_workflows, monkeypatch, tmp_path: Path
):
    monkeypatch.setattr("besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/bin/docker")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("HF_TOKEN", "test-token")
    workflow = next(c for c in example_workflows if c.workflow_id == "nemo-rnnt")
    audio = tmp_path / ("a" * 64 + ".wav")
    audio.write_bytes(b"audio")
    other = tmp_path / ("b" * 64 + ".wav")
    other.write_bytes(b"other")
    prepared = [
        PreparedEntry(
            sha256=hash_char * 64, source=path, staged=path, action="existing", duration_seconds=60
        )
        for hash_char, path in [("a", audio), ("b", other)]
    ]
    jobs = [TranscriptionJob(config=workflow, hashes={"a" * 64})]
    built = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts"),
        transcription_jobs=jobs,
        hashes_for_pyannote_diarization=set(),
    )
    assert len(built) == 1
    argv = list(built[0].argv)
    assert argv[0:2] == ["docker", "compose"]
    assert "nemo-rnnt" in argv
    assert "/workspace/besedy/besedy/workflows/transcribe_nemo_rnnt.py" in argv
    assert argv[argv.index("--model") + 1] == workflow.model_name
    assert argv[argv.index("--language") + 1] == "cs"
    assert argv[argv.index("--vad-model") + 1] == "silero_vad_v6"
    assert argv[argv.index("--audio") + 1 :] == [str(audio)]
    assert "HF_TOKEN=test-token" in argv
    assert not any("transcribe_nemo.py" in item for item in argv)


def test_rnnt_rejects_cpu_docker_runtime(tmp_path: Path):
    with pytest.raises(RuntimeError, match="GPU-only"):
        build_python_backend_process(
            backend_id="nemo-rnnt",
            display_name="NeMo RNNT",
            script_path=PROJECT_ROOT / "besedy/workflows/transcribe_nemo_rnnt.py",
            script_args=[],
            docker_service="nemo-rnnt",
            docker_gpus=None,
        )


def test_rnnt_config_rejects_unused_external_aligner():
    with pytest.raises(ValueError, match="does not accept align_model"):
        config_settings._load_transcription_workflows(
            {
                "transcription_workflows": [
                    {
                        "workflow_id": "nemo-rnnt",
                        "workflow_label": "nemo-rnnt",
                        "model": "nvidia/nemotron-labs-unified-asr-0.6b",
                        "vad_model": "silero_vad_v6",
                        "align_model": "unused-aligner",
                    }
                ],
            }
        )
