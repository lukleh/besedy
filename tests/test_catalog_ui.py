"""Tests for shared catalog workflow summary helpers."""

from __future__ import annotations

from pathlib import Path

from besedy.commands.catalog.ui import print_workflow_summary
from besedy.lib.audio.types import PreparedEntry, SkippedEntry


def make_prepared_entry() -> PreparedEntry:
    """Create a minimal prepared entry for workflow summary tests."""

    return PreparedEntry(
        sha256="a" * 64,
        source=Path("/tmp/source.wav"),
        staged=Path("/tmp/staged.wav"),
        action="existing",
        duration_seconds=1.0,
        normalized=False,
    )


def make_skipped_entry(char: str, reason: str = "file not found") -> SkippedEntry:
    """Create a skipped entry whose sha256 is ``char`` repeated."""

    return SkippedEntry(
        sha256=char * 64,
        source=Path(f"/tmp/{char}.wav"),
        reason=reason,
    )


class TestPrintWorkflowSummary:
    """Tests for end-user workflow summary text."""

    def test_reports_nonzero_when_skips_present(self, capsys):
        """The summary should not claim success when rows were skipped."""

        print_workflow_summary([make_prepared_entry()], [make_skipped_entry("b")], [])

        captured = capsys.readouterr()

        assert "All workflows completed successfully." not in captured.out
        assert "command will exit with status 1" in captured.out

    def test_keeps_success_message_for_already_complete_rows(self, capsys):
        """Rows whose outputs already exist do not spoil a successful run."""

        print_workflow_summary([make_prepared_entry()], [], [], already_complete=1)

        captured = capsys.readouterr()

        assert "Already complete: 1" in captured.out
        assert "All workflows completed successfully." in captured.out

    def test_reports_already_complete_rows_as_a_count(self, capsys):
        """Re-runs report already-complete rows as one line, not one line per row."""

        print_workflow_summary([], [], [], already_complete=3)

        captured = capsys.readouterr()

        assert "Already complete: 3" in captured.out
        assert "Skipped rows" not in captured.out
        assert "No workflows executed; all entries were already complete." in captured.out

    def test_omits_already_complete_line_when_zero(self, capsys):
        """A fresh run does not mention already-complete rows at all."""

        print_workflow_summary([], [], [])

        captured = capsys.readouterr()

        assert "Already complete" not in captured.out
        assert "No workflows were queued." in captured.out

    def test_lists_skips_next_to_already_complete_count(self, capsys):
        """Collapsing already-complete rows must not hide real errors."""

        print_workflow_summary([], [make_skipped_entry("b")], [], already_complete=1)

        captured = capsys.readouterr()

        assert "Already complete: 1" in captured.out
        assert f"{'b' * 64}: file not found" in captured.out
        assert (
            "No workflows completed successfully; command will exit with status 1." in captured.out
        )
