"""Tests for catalog transcribe command behavior."""

from __future__ import annotations

import argparse
from pathlib import Path

import pytest

from besedy.cli.catalog import main
from besedy.commands.catalog import transcribe as transcribe_module
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.workflow.common import CsvAudioRow
from besedy.lib.workflow.config import WorkflowConfig
from tests.helpers.workflows import make_workflow_config


@pytest.mark.parametrize("workflow_id", ["whisperx", "canary-nemo-beam"])
def test_unavailable_whisperx_runtime_fails_transcription(
    workflow_id: str, monkeypatch, tmp_path: Path, capsys
) -> None:
    """Requested transcription and beam alignment must not silently disappear."""
    config = make_workflow_config(
        workflow_id=workflow_id,
        workflow_label=workflow_id,
        decode_strategy="beam" if workflow_id == "canary-nemo-beam" else None,
    )
    output_root = tmp_path / "transcripts"
    audio_hash = "a" * 64
    audio = tmp_path / "staged.wav"
    row = CsvAudioRow(audio_hash=audio_hash, full_path=str(audio))
    if workflow_id == "canary-nemo-beam":
        # NeMo already finished; WhisperX alone must produce transcript.json.
        output = transcribe_module.path_builder(config).workflow_dir(output_root) / audio_hash
        output.mkdir(parents=True)
        (output / "nemo_beam_segments.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(transcribe_module, "get_transcription_workflows", lambda **_: [config])
    monkeypatch.setattr(
        transcribe_module, "resolve_and_load_catalog", lambda *_: (tmp_path / "catalog.csv", [row])
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _: ("run", "transcripts"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_: True)
    monkeypatch.setattr(
        transcribe_module,
        "validate_staged_audio",
        lambda _: ([PreparedEntry(audio_hash, audio, audio, "existing", 1.0)], []),
    )
    monkeypatch.setattr("besedy.lib.runtime.backend_runtime.shutil.which", lambda _: None)
    launched = []
    monkeypatch.setattr(transcribe_module, "launch_workflows", lambda *args: launched.append(args))

    assert (
        main(
            [
                "transcribe",
                "--workflow",
                workflow_id,
                "--output-root",
                str(output_root),
            ]
        )
        == 1
    )

    captured = capsys.readouterr()
    assert "WhisperX" in captured.err
    assert "Docker" in captured.err
    assert "All workflows completed successfully" not in captured.out
    assert launched == []


def test_handle_transcribe_accepts_namespace_without_hash_filter(monkeypatch):
    """Pipeline-created namespaces without hash_filter should not crash."""

    def fake_resolve_and_load_catalog(_csv, _purpose, _default):
        return None

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        fake_resolve_and_load_catalog,
    )

    args = argparse.Namespace(
        csv=None,
        limit=None,
    )

    assert transcribe_module.handle_transcribe(args) == 0


def test_handle_transcribe_rejects_unknown_workflow_selection(
    monkeypatch,
    tmp_path: Path,
    capsys,
) -> None:
    """An unmatched --workflow value names itself and the configured workflows."""
    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [
            make_workflow_config(),
            make_workflow_config(workflow_id="canary-nemo-beam", workflow_label="canary-nemo-beam"),
        ],
    )

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["nemo", "faster-whisper"],
    )

    assert transcribe_module.handle_transcribe(request) == 1
    stderr = capsys.readouterr().err
    assert "unknown --workflow value(s): nemo" in stderr
    assert "canary-nemo-beam" in stderr
    assert "faster-whisper" in stderr


def test_handle_transcribe_accepts_workflow_id_prefix(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """A shared prefix keeps selecting its related workflow IDs."""
    beam = make_workflow_config(workflow_id="canary-nemo-beam", workflow_label="canary-nemo-beam")
    selected: list[WorkflowConfig] = []

    class DummyPathBuilder:
        def __init__(self, config: WorkflowConfig) -> None:
            self.config = config

        def workflow_dir(self, _root: Path) -> Path:
            selected.append(self.config)
            return tmp_path / self.config.workflow_id

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [make_workflow_config(), beam],
    )
    monkeypatch.setattr(transcribe_module, "path_builder", DummyPathBuilder)
    monkeypatch.setattr(transcribe_module, "print_workflow_summary", lambda *_args, **_kwargs: None)

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["canary"],
    )

    assert transcribe_module.handle_transcribe(request) == 0
    assert selected == [beam]


def test_handle_transcribe_selects_only_requested_language_variant(
    monkeypatch,
    tmp_path: Path,
) -> None:
    automatic = make_workflow_config(vad_model="silero", language="auto")
    english = make_workflow_config(vad_model="silero", language="en")
    selected: list[WorkflowConfig] = []

    class DummyPathBuilder:
        def __init__(self, config: WorkflowConfig) -> None:
            self.config = config

        def workflow_dir(self, _root: Path) -> Path:
            selected.append(self.config)
            return tmp_path / self.config.language

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", []),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [automatic, english],
    )
    monkeypatch.setattr(transcribe_module, "path_builder", DummyPathBuilder)
    monkeypatch.setattr(transcribe_module, "print_workflow_summary", lambda *_args, **_kwargs: None)

    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path / "transcripts",
        workflows=["faster-whisper"],
        model="large-v3",
        language="EN",
    )

    assert transcribe_module.handle_transcribe(request) == 0
    assert selected == [english]


def test_handle_transcribe_reports_already_complete_rows(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """Rows with every requested output are counted without being validated again."""
    config = make_workflow_config()
    output_root = tmp_path / "transcripts"
    audio_hash = "a" * 64
    transcript = transcribe_module.path_builder(config).workflow_dir(output_root) / audio_hash
    transcript.mkdir(parents=True)
    (transcript / "transcript.json").write_text("{}", encoding="utf-8")

    row = CsvAudioRow(audio_hash=audio_hash, full_path=str(tmp_path / "source.wav"))
    summaries: list[dict[str, int]] = []

    def fail_validation(_rows) -> None:
        raise AssertionError("validation should not run")

    def capture_summary(staged, skipped, failures, **kwargs) -> None:
        assert list(staged) == []
        assert list(skipped) == []
        assert list(failures) == []
        summaries.append(kwargs)

    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", [row]),
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(
        transcribe_module,
        "get_transcription_workflows",
        lambda **_kwargs: [config],
    )
    monkeypatch.setattr(
        transcribe_module,
        "validate_staged_audio",
        fail_validation,
    )
    monkeypatch.setattr(
        transcribe_module,
        "print_workflow_summary",
        capture_summary,
    )

    request = transcribe_module.TranscribeRequest(output_root=output_root)

    assert transcribe_module.handle_transcribe(request) == 0
    assert summaries == [{"already_complete": 1}]


def _capture_transcription_jobs(
    monkeypatch, tmp_path, configs, rows, invalid_hashes=(), **request_options
):
    monkeypatch.setattr(
        transcribe_module, "resolve_and_load_catalog", lambda *_: (tmp_path / "catalog.csv", rows)
    )
    monkeypatch.setattr(transcribe_module, "extract_run_info", lambda _: ("run", "transcripts"))
    monkeypatch.setattr(transcribe_module, "setup_output_root", lambda *_: True)
    monkeypatch.setattr(
        transcribe_module,
        "validate_staged_audio",
        lambda selected: (
            [
                PreparedEntry(row.audio_hash, Path(row.full_path), Path(row.full_path), "existing", 1)
                for row in selected
                if row.audio_hash not in invalid_hashes
            ],
            [
                (row.audio_hash, Path(row.full_path), "invalid staged audio")
                for row in selected
                if row.audio_hash in invalid_hashes
            ],
        ),
    )
    captured = []
    monkeypatch.setattr(
        transcribe_module,
        "build_workflows",
        lambda *_, **kwargs: captured.extend(kwargs["transcription_jobs"]) or [],
    )
    request = transcribe_module.TranscribeRequest(
        output_root=tmp_path, workflow_configs=tuple(configs), **request_options
    )
    assert transcribe_module.handle_transcribe(request) == (
        transcribe_module.EXIT_ROWS_SKIPPED if invalid_hashes else 0
    )
    return captured


def test_exact_configuration_is_not_selected_again(monkeypatch, tmp_path):
    """A selected VAD/aligner variant cannot expand into non-pipeline siblings."""
    selected = make_workflow_config(vad_model="selected-vad", align_model="selected-aligner")

    def unexpected_selection(**_):
        raise AssertionError("an internal configuration must not be selected again")

    monkeypatch.setattr(transcribe_module, "get_transcription_workflows", unexpected_selection)
    jobs = _capture_transcription_jobs(
        monkeypatch, tmp_path, [selected], [CsvAudioRow("a" * 64, "audio.wav")]
    )
    assert len(jobs) == 1
    assert jobs[0].config is selected


def test_exact_configuration_rejects_ambiguous_selector_overrides(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(
        transcribe_module,
        "resolve_and_load_catalog",
        lambda *_: pytest.fail("catalog must not be read"),
    )
    request = transcribe_module.TranscribeRequest(
        workflow_configs=(make_workflow_config(),), workflows=["faster-whisper"]
    )
    assert transcribe_module.handle_transcribe(request) == 1
    assert "cannot be combined" in capsys.readouterr().err


def test_beam_limit_selects_recordings_with_all_their_required_stages(monkeypatch, tmp_path):
    beam = make_workflow_config(
        workflow_id="canary-nemo-beam", workflow_label="canary-nemo-beam", decode_strategy="beam"
    )
    rows = [CsvAudioRow(char * 64, f"{char}.wav") for char in "ab"]
    first = transcribe_module.path_builder(beam).workflow_dir(tmp_path) / rows[0].audio_hash
    first.mkdir(parents=True)
    (first / "transcript.json").write_text("{}", encoding="utf-8")
    jobs = _capture_transcription_jobs(monkeypatch, tmp_path, [beam], rows, limit=1)
    assert jobs[0].hashes == {rows[0].audio_hash}
    assert jobs[0].align_hashes == set()
    # Once the first row's missing stage is done, the next batch carries both
    # stages for b, instead of aligning b while only a is transcribed.
    (first / "nemo_beam_segments.json").write_text("{}", encoding="utf-8")
    jobs = _capture_transcription_jobs(monkeypatch, tmp_path, [beam], rows, limit=1)
    assert jobs[0].hashes == jobs[0].align_hashes == {rows[1].audio_hash}


def test_each_exact_variant_keeps_its_own_recording_limit(monkeypatch, tmp_path):
    configs = [make_workflow_config(vad_model=name) for name in ("first", "second")]
    rows = [CsvAudioRow(char * 64, f"{char}.wav") for char in "ab"]
    completed = transcribe_module.path_builder(configs[0]).workflow_dir(tmp_path) / rows[0].audio_hash
    completed.mkdir(parents=True)
    (completed / "transcript.json").write_text("{}", encoding="utf-8")
    jobs = _capture_transcription_jobs(monkeypatch, tmp_path, configs, rows, limit=1)
    assert [job.hashes for job in jobs] == [{rows[1].audio_hash}, {rows[0].audio_hash}]


def test_alignment_jobs_exclude_rows_that_failed_staged_validation(monkeypatch, tmp_path):
    beam = make_workflow_config(workflow_id="canary-nemo-beam", decode_strategy="beam")
    rows = [CsvAudioRow(char * 64, f"{char}.wav") for char in "ab"]
    jobs = _capture_transcription_jobs(
        monkeypatch, tmp_path, [beam], rows, invalid_hashes={rows[1].audio_hash}, continue_on_error=True
    )
    assert jobs[0].hashes == jobs[0].align_hashes == {rows[0].audio_hash}
