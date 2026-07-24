from __future__ import annotations

from pathlib import Path

import pytest

from besedy.core.paths import PROJECT_ROOT, hash_component_from_sha
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.workflow.common import WorkflowCommand
from besedy.lib.workflow.config import WorkflowConfig
from besedy.lib.workflow.runner import (
    TranscriptionJob,
    WorkflowRunConfig,
    build_workflows,
    launch_workflows,
)


class DummyPopen:
    _pid_counter = 0

    def __init__(self, returncode: int = 0) -> None:
        self._returncode = returncode
        DummyPopen._pid_counter += 1
        self.pid = DummyPopen._pid_counter

    def wait(self) -> int:
        return self._returncode


def test_launch_workflows_single(monkeypatch):
    """Single workflow succeeds when subprocess.run returns 0."""

    called = {}

    def fake_run(argv, env=None, cwd=None, check=False):
        called["argv"] = argv
        return 0

    monkeypatch.setattr("besedy.lib.workflow.runner.subprocess.run", fake_run)

    spec = WorkflowCommand(label="one", argv=["echo", "hi"])
    failures = launch_workflows([spec], base_env={})

    assert failures == []
    assert called["argv"] == ["echo", "hi"]


def test_launch_workflows_redacts_sensitive_env_values_in_logged_commands(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fake_run(argv, env=None, cwd=None, check=False):
        return 0

    monkeypatch.setattr("besedy.lib.workflow.runner.subprocess.run", fake_run)

    spec = WorkflowCommand(
        label="secret",
        argv=[
            "docker",
            "compose",
            "run",
            "-e",
            "HF_TOKEN=super-secret",
            "-e",
            "VISIBLE=value",
            "svc",
        ],
    )
    failures = launch_workflows([spec], base_env={})

    captured = capsys.readouterr()
    assert failures == []
    assert "HF_TOKEN=***REDACTED***" in captured.out
    assert "super-secret" not in captured.out
    assert "VISIBLE=value" in captured.out


def test_launch_workflows_parallel_group(monkeypatch):
    """Parallel group launches both specs and aggregates failures."""

    started = []

    def fake_popen(argv, env=None, cwd=None):
        started.append(tuple(argv))
        # First succeeds, second fails to exercise failure path
        return DummyPopen(returncode=0 if len(started) == 1 else 7)

    monkeypatch.setattr("besedy.lib.workflow.runner.subprocess.Popen", fake_popen)

    group = "grp"
    specs = [
        WorkflowCommand(label="a1", argv=["cmdA"], parallel_group=group),
        WorkflowCommand(label="a2", argv=["cmdB"], parallel_group=group),
    ]
    failures = launch_workflows(specs, base_env={})

    assert started == [("cmdA",), ("cmdB",)]
    assert failures == [("a2", 7)]


def test_build_workflows_faster_whisper_docker_runtime_forwards_gpu_and_hf_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_FASTER_WHISPER_RUNTIME", "docker")
    monkeypatch.setenv("HF_TOKEN", "secret-token")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "aaaaaaaa.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="a" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="faster-whisper",
        workflow_type="transcription",
        workflow_label="faster-whisper",
        model_name="large-v3",
        vad_model="silero_vad_v6",
        language="en",
    )

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts", cpu=False),
        transcription_jobs=[
            TranscriptionJob(
                config=workflow,
                hashes={hash_component_from_sha(prepared[0].sha256)},
            )
        ],
        hashes_for_pyannote_diarization=set(),
    )

    assert len(workflows) == 1
    argv = list(workflows[0].argv)
    assert argv[:6] == [
        "docker",
        "compose",
        "-f",
        str(PROJECT_ROOT / "backends" / "docker-compose.yml"),
        "run",
        "--rm",
    ]
    assert "--gpus" not in argv
    assert "faster-whisper" in argv
    assert argv[argv.index("--language") + 1] == "en"
    assert "HF_TOKEN=secret-token" in argv


def test_build_workflows_faster_whisper_cpu_mode_sets_cpu_args(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_FASTER_WHISPER_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "bbbbbbbb.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="b" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="faster-whisper",
        workflow_type="transcription",
        workflow_label="faster-whisper",
        model_name="large-v3",
        vad_model="silero_vad_v6",
    )

    with pytest.raises(RuntimeError, match="GPU-only in Besedy"):
        build_workflows(
            prepared,
            WorkflowRunConfig(output_root=tmp_path / "transcripts", cpu=True),
            transcription_jobs=[
                TranscriptionJob(
                    config=workflow,
                    hashes={hash_component_from_sha(prepared[0].sha256)},
                )
            ],
            hashes_for_pyannote_diarization=set(),
        )


def test_build_workflows_qwen3_asr_docker_runtime_forwards_gpu_and_hf_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_QWEN3_ASR_RUNTIME", "docker")
    monkeypatch.setenv("HF_TOKEN", "secret-token")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "cccccccc.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="c" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="qwen3-asr",
        workflow_type="transcription",
        workflow_label="qwen3-asr",
        model_name="Qwen/Qwen3-ASR-1.7B",
        vad_model="silero_vad_v6",
        align_model="Qwen/Qwen3-ForcedAligner-0.6B",
        language="English",
    )

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts"),
        transcription_jobs=[
            TranscriptionJob(
                config=workflow,
                hashes={hash_component_from_sha(prepared[0].sha256)},
            )
        ],
        hashes_for_pyannote_diarization=set(),
    )

    assert len(workflows) == 1
    argv = list(workflows[0].argv)
    assert argv[:6] == [
        "docker",
        "compose",
        "-f",
        str(PROJECT_ROOT / "backends" / "docker-compose.yml"),
        "run",
        "--rm",
    ]
    assert "--gpus" not in argv
    assert "qwen3-asr" in argv
    assert argv[argv.index("--language") + 1] == "English"
    assert "HF_TOKEN=secret-token" in argv
    assert "PYTORCH_ALLOC_CONF=expandable_segments:True" in argv
    assert "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True" in argv


def test_build_workflows_whisperx_docker_runtime_forwards_gpu_and_hf_token(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_WHISPERX_RUNTIME", "docker")
    monkeypatch.setenv("HF_TOKEN", "secret-token")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "dddddddd.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="d" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="whisperx",
        workflow_type="transcription",
        workflow_label="whisperx",
        model_name="large-v3",
        vad_model="silero",
        align_model="WAV2VEC2_ASR_LARGE_LV60K_960H",
        language="auto",
    )

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts"),
        transcription_jobs=[
            TranscriptionJob(
                config=workflow,
                hashes={hash_component_from_sha(prepared[0].sha256)},
            )
        ],
        hashes_for_pyannote_diarization=set(),
    )

    assert len(workflows) == 1
    argv = list(workflows[0].argv)
    assert argv[:6] == [
        "docker",
        "compose",
        "-f",
        str(PROJECT_ROOT / "backends" / "docker-compose.yml"),
        "run",
        "--rm",
    ]
    assert "--gpus" not in argv
    assert "whisperx" in argv
    assert argv[argv.index("--language") + 1] == "auto"
    assert "HF_TOKEN=secret-token" in argv
    assert "BESEDY_WHISPERX_CLI=whisperx" in argv


def test_build_workflows_whisperx_rejects_removed_isolated_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_WHISPERX_RUNTIME", "isolated")

    staged_audio = tmp_path / "whisperx.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="1" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="whisperx",
        workflow_type="transcription",
        workflow_label="whisperx",
        model_name="large-v3",
        vad_model="silero",
        align_model="WAV2VEC2_ASR_LARGE_LV60K_960H",
    )

    with pytest.raises(RuntimeError, match="Docker-only"):
        build_workflows(
            prepared,
            WorkflowRunConfig(output_root=tmp_path / "transcripts"),
            transcription_jobs=[
                TranscriptionJob(
                    config=workflow,
                    hashes={hash_component_from_sha(prepared[0].sha256)},
                )
            ],
            hashes_for_pyannote_diarization=set(),
        )


def test_build_workflows_nemo_docker_runtime_forwards_gpu_and_nemo_env(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_NEMO_RUNTIME", "docker")
    monkeypatch.setenv("NEMO_LOG_TEXT_NO_WORDS", "1")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "eeeeeeee.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="e" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="canary-nemo",
        workflow_type="transcription",
        workflow_label="canary-nemo",
        model_name="nvidia/canary-1b-v2",
        vad_model="frame_vad",
        language="cs",
    )

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts", nemo_parallel=1),
        transcription_jobs=[
            TranscriptionJob(
                config=workflow,
                hashes={hash_component_from_sha(prepared[0].sha256)},
            )
        ],
        hashes_for_pyannote_diarization=set(),
    )

    assert len(workflows) == 1
    argv = list(workflows[0].argv)
    assert argv[:6] == [
        "docker",
        "compose",
        "-f",
        str(PROJECT_ROOT / "backends" / "docker-compose.yml"),
        "run",
        "--rm",
    ]
    assert "--gpus" not in argv
    assert "nemo" in argv
    assert argv[argv.index("--source-lang") + 1] == "cs"
    assert argv[argv.index("--target-lang") + 1] == "cs"
    assert "NEMO_LOG_TEXT_NO_WORDS=1" in argv
    assert "BESEDY_NEMO_VAD_NUM_WORKERS=0" in argv
    assert "PYTORCH_ALLOC_CONF=expandable_segments:True" in argv


def test_build_workflows_nemo_beam_align_mounts_staged_audio_for_docker(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_NEMO_RUNTIME", "docker")
    monkeypatch.setenv("BESEDY_WHISPERX_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "ffffffff.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="f" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="canary-nemo",
        workflow_type="transcription",
        workflow_label="canary-nemo",
        model_name="nvidia/canary-1b-v2",
        vad_model="frame_vad",
        align_model="comodoro/wav2vec2-xls-r-300m-cs-250",
        decode_strategy="beam",
        language="cs",
    )
    hash_component = hash_component_from_sha(prepared[0].sha256)

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts", nemo_parallel=1),
        transcription_jobs=[
            TranscriptionJob(
                config=workflow,
                hashes={hash_component},
                align_hashes={hash_component},
            )
        ],
        hashes_for_pyannote_diarization=set(),
    )

    assert len(workflows) == 2
    align_argv = list(workflows[1].argv)
    assert "whisperx" in align_argv
    assert align_argv[align_argv.index("--language") + 1] == "cs"
    assert f"{staged_audio.parent}:{staged_audio.parent}:ro" in align_argv


def test_build_workflows_nemo_beam_align_rejects_removed_whisperx_isolated_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_WHISPERX_RUNTIME", "isolated")
    monkeypatch.setenv("BESEDY_NEMO_RUNTIME", "docker")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "beam.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="2" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]
    workflow = WorkflowConfig(
        workflow_id="canary-nemo",
        workflow_type="transcription",
        workflow_label="canary-nemo",
        model_name="nvidia/canary-1b-v2",
        vad_model="frame_vad",
        align_model="comodoro/wav2vec2-xls-r-300m-cs-250",
        decode_strategy="beam",
    )
    hash_component = hash_component_from_sha(prepared[0].sha256)

    with pytest.raises(RuntimeError, match="Docker-only"):
        build_workflows(
            prepared,
            WorkflowRunConfig(output_root=tmp_path / "transcripts", nemo_parallel=1),
            transcription_jobs=[
                TranscriptionJob(
                    config=workflow,
                    hashes={hash_component},
                    align_hashes={hash_component},
                )
            ],
            hashes_for_pyannote_diarization=set(),
        )


def test_build_workflows_pyannote_docker_runtime_sets_checkpoint_load_override(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("BESEDY_PYANNOTE_RUNTIME", "docker")
    monkeypatch.setenv("HF_TOKEN", "secret-token")
    monkeypatch.setattr(
        "besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/usr/bin/docker"
    )

    staged_audio = tmp_path / "99999999.wav"
    staged_audio.write_bytes(b"x")
    prepared = [
        PreparedEntry(
            sha256="9" * 64,
            source=staged_audio,
            staged=staged_audio,
            action="existing",
            duration_seconds=1.0,
        )
    ]

    workflows = build_workflows(
        prepared,
        WorkflowRunConfig(
            output_root=tmp_path / "transcripts",
            enable_pyannote_diarization=True,
        ),
        transcription_jobs=[],
        hashes_for_pyannote_diarization={hash_component_from_sha(prepared[0].sha256)},
    )

    assert len(workflows) == 1
    argv = list(workflows[0].argv)
    assert "pyannote" in argv
    assert "HF_TOKEN=secret-token" in argv
    assert "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD=1" in argv
