"""Exit codes of the per-row catalog steps: 2 when rows were skipped, 1 when the step failed."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from besedy.commands.catalog import diarize as diarize_module
from besedy.commands.catalog import stage as stage_module
from besedy.commands.catalog import transcribe as transcribe_module
from besedy.commands.catalog.extract import ExportTranscriptsRequest, handle_export_transcripts
from besedy.lib.audio.types import SkippedEntry
from besedy.lib.workflow.common import EXIT_ROWS_SKIPPED, CsvAudioRow
from tests.helpers.transcript import create_minimal_transcript, write_transcript_json
from tests.helpers.workflows import make_workflow_config

TS = "20260101_120000"
HASH_A = "a" * 64
HASH_B = "b" * 64


def test_rows_skipped_exit_code_is_two() -> None:
    assert EXIT_ROWS_SKIPPED == 2


# --- stage-audio ----------------------------------------------------------------


@pytest.fixture
def loudness_csv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(stage_module, "resolve_audio_artifacts_root", lambda: tmp_path)
    monkeypatch.setattr(
        stage_module, "load_audio_rows", lambda *_args, **_kwargs: [SimpleNamespace()]
    )
    path = tmp_path / f"audio_catalog_{TS}_loudness.csv"
    path.write_text("Hash\n", encoding="utf-8")
    return path


def _staging(*, skipped: list[SkippedEntry]):  # type: ignore[no-untyped-def]
    def stage_audio_files(_rows, _staging_dir, *, manifest_writer, **_kwargs):  # type: ignore[no-untyped-def]
        manifest_writer.write_entry(
            SimpleNamespace(sha256=HASH_A, staged=Path("/staged/a.wav")), size_bytes=1
        )
        return [], skipped

    return stage_audio_files


def test_stage_audio_exits_2_when_rows_are_skipped(
    loudness_csv: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    skipped = [SkippedEntry(HASH_B, Path("/missing/b.mp3"), "file not found")]
    monkeypatch.setattr(stage_module, "stage_audio_files", _staging(skipped=skipped))

    request = stage_module.StageAudioRequest(
        csv=loudness_csv, output_dir=tmp_path / "staged", skip_audio_analysis=True
    )
    assert stage_module.handle_stage_audio(request) == EXIT_ROWS_SKIPPED


def test_stage_audio_exits_0_without_skips(
    loudness_csv: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(stage_module, "stage_audio_files", _staging(skipped=[]))

    request = stage_module.StageAudioRequest(
        csv=loudness_csv, output_dir=tmp_path / "staged", skip_audio_analysis=True
    )
    assert stage_module.handle_stage_audio(request) == 0


# --- transcribe and diarize -----------------------------------------------------


def _stub_transcribe(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    prepared: list[object],
    launch_failures: list[tuple[str, int]],
) -> None:
    rows = [CsvAudioRow(sha256=HASH_A, full_path=str(tmp_path / "a.wav"))]
    monkeypatch.setattr(
        transcribe_module, "resolve_and_load_catalog", lambda *_args: (tmp_path / "c.csv", rows)
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module, "get_transcription_workflows", lambda **_k: [make_workflow_config()]
    )
    monkeypatch.setattr(
        transcribe_module,
        "validate_staged_audio",
        lambda _rows: (prepared, [(HASH_A, Path("/staged/a.wav"), "staged audio missing")]),
    )
    monkeypatch.setattr(transcribe_module, "build_workflows", lambda *_a, **_k: ["job"])
    monkeypatch.setattr(transcribe_module, "prepare_workflow_env", lambda: {})
    monkeypatch.setattr(transcribe_module, "launch_workflows", lambda *_a: launch_failures)
    monkeypatch.setattr(transcribe_module, "print_workflow_summary", lambda *_a, **_k: None)


def test_transcribe_exits_2_when_rows_are_skipped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_transcribe(monkeypatch, tmp_path, prepared=[], launch_failures=[])

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts", continue_on_error=True
    )
    assert transcribe_module.handle_transcribe(request) == EXIT_ROWS_SKIPPED


def test_transcribe_exits_1_when_a_workflow_fails_even_with_skips(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_transcribe(monkeypatch, tmp_path, prepared=[object()], launch_failures=[("fw", 1)])

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts", continue_on_error=True
    )
    assert transcribe_module.handle_transcribe(request) == 1


def test_transcribe_still_exits_1_on_skips_without_continue_on_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_transcribe(monkeypatch, tmp_path, prepared=[], launch_failures=[])

    request = transcribe_module.TranscribeRequest(output_root=tmp_path / "transcripts")
    assert transcribe_module.handle_transcribe(request) == 1


def _stub_diarize(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    prepared: list[object],
    launch_failures: list[tuple[str, int]],
) -> None:
    rows = [CsvAudioRow(sha256=HASH_A, full_path=str(tmp_path / "a.wav"))]
    monkeypatch.setattr(
        diarize_module, "resolve_and_load_catalog", lambda *_args: (tmp_path / "c.csv", rows)
    )
    monkeypatch.setattr(diarize_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(diarize_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(diarize_module, "artifact_exists", lambda *_args: False)
    monkeypatch.setattr(
        diarize_module,
        "validate_staged_audio",
        lambda _rows: (prepared, [(HASH_A, Path("/staged/a.wav"), "staged audio missing")]),
    )
    monkeypatch.setattr(diarize_module, "build_workflows", lambda *_a, **_k: ["job"])
    monkeypatch.setattr(diarize_module, "prepare_workflow_env", lambda: {})
    monkeypatch.setattr(diarize_module, "launch_workflows", lambda *_a: launch_failures)
    monkeypatch.setattr(diarize_module, "print_workflow_summary", lambda *_a, **_k: None)


def test_diarize_exits_2_when_rows_are_skipped(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_diarize(monkeypatch, tmp_path, prepared=[], launch_failures=[])

    request = diarize_module.DiarizeRequest(
        output_root=tmp_path / "transcripts", continue_on_error=True
    )
    assert diarize_module.handle_diarize(request) == EXIT_ROWS_SKIPPED


def test_diarize_exits_1_when_the_backend_fails_even_with_skips(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _stub_diarize(monkeypatch, tmp_path, prepared=[object()], launch_failures=[("pyannote", 1)])

    request = diarize_module.DiarizeRequest(
        output_root=tmp_path / "transcripts", continue_on_error=True
    )
    assert diarize_module.handle_diarize(request) == 1


# --- export-transcripts ---------------------------------------------------------


def test_export_transcripts_exits_2_and_exports_the_rest_when_one_is_unreadable(
    tmp_path: Path,
) -> None:
    backend_dir = tmp_path / f"transcripts_{TS}" / "faster-whisper" / "large-v3@lang-cs"
    good = write_transcript_json(
        backend_dir / HASH_A / "transcript.json", create_minimal_transcript()
    )
    bad = backend_dir / HASH_B / "transcript.json"
    bad.parent.mkdir(parents=True)
    bad.write_bytes(b'{"segments": [\xff')

    request = ExportTranscriptsRequest(transcripts_root=tmp_path / f"transcripts_{TS}")
    assert handle_export_transcripts(request) == EXIT_ROWS_SKIPPED
    assert (good.parent / "transcript.txt").is_file()
    assert not (bad.parent / "transcript.txt").exists()


# --- the ingest flow's check of the upload's own transcripts --------------------


def test_missing_pipeline_transcripts_lists_only_absent_workflow_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from besedy.lib.workflow import paths as workflow_paths

    faster = make_workflow_config()
    canary = make_workflow_config(
        workflow_id="canary-nemo",
        workflow_label="canary-nemo",
        model_name="nvidia/canary-1b-v2",
        vad_model="nvidia/Frame_VAD_Multilingual_MarbleNet_v2.0",
        decode_strategy="greedy",
    )
    monkeypatch.setattr(workflow_paths, "resolve_transcripts_parent", lambda: tmp_path)
    monkeypatch.setattr(
        workflow_paths, "get_transcription_workflows", lambda **_k: [faster, canary]
    )
    run_root = tmp_path / f"transcripts_{TS}"
    present = (
        workflow_paths.path_builder(faster).workflow_dir(run_root) / HASH_A / "transcript.json"
    )
    write_transcript_json(present, create_minimal_transcript())
    csv_path = tmp_path / f"audio_catalog_{TS}.csv"
    csv_path.write_text("Hash\n", encoding="utf-8")

    missing = workflow_paths.missing_pipeline_transcripts(csv_path, HASH_A.upper())

    assert missing == [
        workflow_paths.path_builder(canary).workflow_dir(run_root) / HASH_A / "transcript.json"
    ]
    write_transcript_json(missing[0], create_minimal_transcript())
    assert workflow_paths.missing_pipeline_transcripts(csv_path, HASH_A) == []


def test_missing_pipeline_transcripts_requires_a_timestamped_catalog(tmp_path: Path) -> None:
    from besedy.lib.workflow.paths import missing_pipeline_transcripts

    with pytest.raises(ValueError, match="not timestamped"):
        missing_pipeline_transcripts(tmp_path / "audio_catalog.csv", HASH_A)
