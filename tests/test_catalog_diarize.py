"""Tests for catalog diarization command behavior."""

from __future__ import annotations

from pathlib import Path

from besedy.commands.catalog import diarize as diarize_module
from besedy.lib.workflow.common import CsvAudioRow


def test_handle_diarize_reports_already_complete_rows(
    monkeypatch,
    tmp_path: Path,
) -> None:
    """Rows with diarization output are counted without being validated again."""
    output_root = tmp_path / "transcripts"
    row = CsvAudioRow(sha256="a" * 64, full_path=str(tmp_path / "source.wav"))
    summaries: list[dict[str, int]] = []

    def fail_validation(_rows) -> None:
        raise AssertionError("validation should not run")

    def capture_summary(staged, skipped, failures, **kwargs) -> None:
        assert list(staged) == []
        assert list(skipped) == []
        assert list(failures) == []
        summaries.append(kwargs)

    monkeypatch.setattr(
        diarize_module,
        "resolve_and_load_catalog",
        lambda *_args: (tmp_path / "catalog.csv", [row]),
    )
    monkeypatch.setattr(diarize_module, "extract_run_info", lambda _path: ("run", "base"))
    monkeypatch.setattr(diarize_module, "setup_output_root", lambda *_args: True)
    monkeypatch.setattr(diarize_module, "artifact_exists", lambda *_args: True)
    monkeypatch.setattr(
        diarize_module,
        "validate_staged_audio",
        fail_validation,
    )
    monkeypatch.setattr(
        diarize_module,
        "print_workflow_summary",
        capture_summary,
    )

    request = diarize_module.DiarizeRequest(output_root=output_root)

    assert diarize_module.handle_diarize(request) == 0
    assert summaries == [{"already_complete": 1}]
