"""ARK's optional two-stage workflow and canonical metadata boundaries."""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace

import pytest

import besedy.config.settings as config_settings
from besedy.commands.catalog import transcribe as transcribe_module
from besedy.core.paths import PROJECT_ROOT
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.data.whisperx_conversion import convert_whisperx
from besedy.lib.runtime.backend_runtime import build_python_backend_process
from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.config import get_transcription_workflows
from besedy.lib.workflow.paths import path_builder
from besedy.lib.workflow.runner import TranscriptionJob, WorkflowRunConfig, build_workflows
from besedy.workflows import align_nemo_with_whisperx as align_module

AUDIO_HASH = "a" * 64


@pytest.fixture
def ark_config(monkeypatch):
    monkeypatch.setenv("BESEDY_CONFIG", str(PROJECT_ROOT / "besedy.toml.example"))
    monkeypatch.setattr(config_settings, "_CONFIG", None)
    return next(c for c in get_transcription_workflows() if c.workflow_id == "ark-asr")


def test_ark_is_explicit_only_with_required_czech_alignment(ark_config):
    assert ark_config.model_name == "Edge0/ARK-ASR-0.6B"
    assert ark_config.align_model == "comodoro/wav2vec2-xls-r-300m-cs-250"
    assert ark_config.language == "cs"
    assert not ark_config.pipeline_default and not ark_config.expected_default
    assert ark_config not in get_transcription_workflows(pipeline_only=True)
    assert ark_config not in get_transcription_workflows(expected_only=True)


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ({}, "requires align_model"),
        ({"align_model": "aligner", "language": "auto"}, "concrete language"),
    ],
)
def test_ark_rejects_unalignable_config(extra, message):
    with pytest.raises(ValueError, match=message):
        config_settings._load_transcription_workflows(
            {
                "transcription_workflows": [
                    {
                        "workflow_id": "ark-asr",
                        "workflow_label": "ark-asr",
                        "model": "Edge0/ARK-ASR-0.6B",
                        "vad_model": "silero_vad_v6",
                        **extra,
                    }
                ]
            }
        )


def test_ark_is_gpu_only():
    with pytest.raises(RuntimeError, match="GPU-only"):
        build_python_backend_process(
            backend_id="ark-asr",
            display_name="ARK-ASR",
            script_path=PROJECT_ROOT / "besedy/workflows/transcribe_ark_asr.py",
            script_args=[],
            docker_service="ark-asr",
            docker_gpus=None,
        )


@pytest.mark.parametrize("overwrite", [False, True])
def test_ark_builds_asr_then_alignment_with_matching_identity(
    ark_config,
    monkeypatch,
    tmp_path,
    overwrite,
):
    monkeypatch.setattr("besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/bin/docker")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("HF_TOKEN", "test-token")
    audio = tmp_path / f"{AUDIO_HASH}.wav"
    audio.touch()
    prepared = [PreparedEntry(AUDIO_HASH, audio, audio, "existing", 60)]
    built = build_workflows(
        prepared,
        WorkflowRunConfig(output_root=tmp_path / "transcripts", overwrite=overwrite),
        transcription_jobs=[TranscriptionJob(ark_config, {AUDIO_HASH}, {AUDIO_HASH})],
        hashes_for_pyannote_diarization=set(),
    )
    assert len(built) == 2
    asr, align = [list(w.argv) for w in built]
    assert built[1].prerequisite_label == built[0].label
    assert "/workspace/besedy/besedy/workflows/transcribe_ark_asr.py" in asr
    assert "/workspace/besedy/besedy/workflows/align_nemo_with_whisperx.py" in align
    assert asr[asr.index("--audio") + 1 :] == [str(audio)]
    expected_raw = (
        path_builder(ark_config).workflow_dir(tmp_path / "transcripts")
        / AUDIO_HASH
        / "ark_segments.json"
    )
    assert align[align.index("--segments") + 1] == str(expected_raw)
    assert align[align.index("--backend") + 1] == "ark-asr"
    for argv in (asr, align):
        assert argv[argv.index("--model") + 1] == ark_config.model_name
        assert argv[argv.index("--language") + 1] == "cs"
        assert argv[argv.index("--align-model") + 1] == ark_config.align_model
        assert ("--skip-existing" in argv) is not overwrite
        assert "HF_TOKEN=test-token" in argv
        assert any(str(audio.parent) in arg for arg in argv)


@pytest.mark.parametrize(
    ("raw_exists", "canonical_exists", "overwrite", "asr_pending", "align_pending"),
    [
        (False, False, False, True, True),
        (True, False, False, True, True),
        (True, True, False, False, False),
        (False, True, False, False, False),
        (True, True, True, True, True),
    ],
)
def test_ark_catalog_revalidates_raw_until_canonical_completion(
    ark_config,
    monkeypatch,
    tmp_path,
    raw_exists,
    canonical_exists,
    overwrite,
    asr_pending,
    align_pending,
):
    output_root = tmp_path / "transcripts"
    artifact_dir = path_builder(ark_config).workflow_dir(output_root) / AUDIO_HASH
    artifact_dir.mkdir(parents=True)
    if raw_exists:
        (artifact_dir / "ark_segments.json").write_text("{}")
    if canonical_exists:
        (artifact_dir / "transcript.json").write_text("{}")
    audio = tmp_path / f"{AUDIO_HASH}.wav"
    row = CsvAudioRow(sha256=AUDIO_HASH, full_path=str(audio))
    monkeypatch.setattr(transcribe_module, "get_transcription_workflows", lambda **_: [ark_config])
    monkeypatch.setattr(
        transcribe_module, "resolve_and_load_catalog", lambda *_: (tmp_path / "catalog.csv", [row])
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _: ("run", "transcripts"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_: True)
    monkeypatch.setattr(
        transcribe_module,
        "validate_staged_audio",
        lambda _: ([PreparedEntry(AUDIO_HASH, audio, audio, "existing", 60)], []),
    )
    pending = []

    def capture(*_, transcription_jobs, **__):
        pending.extend(transcription_jobs)
        return []

    monkeypatch.setattr(transcribe_module, "build_workflows", capture)
    assert (
        transcribe_module.handle_transcribe(
            transcribe_module.TranscribeRequest(
                output_root=output_root,
                workflows=["ark-asr"],
                overwrite=overwrite,
            )
        )
        == 0
    )
    if not asr_pending and not align_pending:
        assert pending == []
    else:
        assert len(pending) == 1
        assert pending[0].hashes == ({AUDIO_HASH} if asr_pending else set())
        assert pending[0].align_hashes == ({AUDIO_HASH} if align_pending else set())


def test_alignment_only_resume_does_not_launch_ark(ark_config, monkeypatch, tmp_path):
    monkeypatch.setattr("besedy.lib.runtime.backend_runtime.shutil.which", lambda _: "/bin/docker")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    audio = tmp_path / f"{AUDIO_HASH}.wav"
    audio.touch()
    built = build_workflows(
        [PreparedEntry(AUDIO_HASH, audio, audio, "existing", 60)],
        WorkflowRunConfig(output_root=tmp_path / "transcripts"),
        transcription_jobs=[TranscriptionJob(ark_config, align_hashes={AUDIO_HASH})],
        hashes_for_pyannote_diarization=set(),
    )
    assert len(built) == 1
    assert built[0].prerequisite_label is None
    assert "/workspace/besedy/besedy/workflows/align_nemo_with_whisperx.py" in built[0].argv
    assert not any("transcribe_ark_asr.py" in item for item in built[0].argv)


def test_shared_aligner_preserves_raw_provenance_before_conversion(monkeypatch, tmp_path):
    audio = tmp_path / "audio.wav"
    audio.touch()
    raw = tmp_path / "ark_segments.json"
    params = {
        "model_revision": "pinned-revision",
        "code_revision": "pinned-code",
        "asr_language": "auto",
        "alignment_language": "cs",
        "align_model": "stale",
        "word_timestamps": False,
        "timestamp_source": "vad_chunk_boundaries",
    }
    vad_segments = [{"start": 0.0, "end": 1.0}]
    raw.write_text(
        json.dumps(
            {
                "meta": {
                    "audio_filepath": str(audio),
                    "model": "Edge0/ARK-ASR-0.6B",
                    "generation_params": params,
                },
                "segments": [{"start": 0.0, "end": 1.0, "text": "ahoj"}],
                "vad_segments": vad_segments,
            }
        )
    )
    monkeypatch.setitem(
        sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
    )
    monkeypatch.setitem(
        sys.modules,
        "whisperx",
        SimpleNamespace(
            load_align_model=lambda *args, **kwargs: ("align-model", {"language": "cs"}),
            align=lambda *args, **kwargs: {
                "segments": [
                    {
                        "start": 0,
                        "end": 1,
                        "text": "ahoj",
                        "words": [{"word": "ahoj", "start": 0, "end": 1}],
                    }
                ],
                "word_segments": [],
            },
        ),
    )
    aligned_path = tmp_path / "aligned.json"
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "align_nemo_with_whisperx.py",
            "--segments",
            str(raw),
            "--language",
            "cs",
            "--backend",
            "ark-asr",
            "--align-model",
            "configured-aligner",
            "--aligned-output",
            str(aligned_path),
            "--no-progress",
            "--no-convert",
        ],
    )
    align_module.main()
    aligned = json.loads(aligned_path.read_text())
    assert aligned["meta"]["generation_params"] == params
    canonical = convert_whisperx(
        aligned,
        backend="ark-asr",
        model="Edge0/ARK-ASR-0.6B",
        duration_seconds=1,
        audio_filepath=str(audio),
        align_model="configured-aligner",
    )
    assert canonical["meta"]["generation_params"] == {
        **params,
        "language": "cs",
        "align_model": "configured-aligner",
        "word_timestamps": True,
        "asr_word_timestamps": False,
        "timestamp_source": "whisperx_forced_alignment",
        "asr_timestamp_source": "vad_chunk_boundaries",
    }
    assert canonical["vad_segments"] == vad_segments
    assert canonical["segments"][0]["words"][0]["confidence"] is None
    assert not (tmp_path / "transcript.json").exists()
