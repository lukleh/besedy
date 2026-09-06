"""Tests for shared catalog workflow summary helpers."""

from __future__ import annotations

from pathlib import Path

from besedy.commands.catalog.default_paths import ALREADY_EXISTS_REASON
from besedy.commands.catalog.ui import has_error_skips, print_workflow_summary
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


class TestHasErrorSkips:
    """Tests for skipped-row error classification."""

    def test_ignores_resume_skips(self):
        """Already-existing workflow outputs are not treated as errors."""

        skipped = [
            SkippedEntry(
                sha256="a" * 64,
                source=Path("/tmp/source.wav"),
                reason=ALREADY_EXISTS_REASON,
            )
        ]

        assert has_error_skips(skipped) is False

    def test_detects_real_errors(self):
        """Missing files still count as error skips."""

        skipped = [
            SkippedEntry(
                sha256="b" * 64,
                source=Path("/tmp/missing.wav"),
                reason="file not found",
            )
        ]

        assert has_error_skips(skipped) is True


class TestPrintWorkflowSummary:
    """Tests for end-user workflow summary text."""

    def test_reports_nonzero_when_error_skips_present(self, capsys):
        """The summary should not claim success when real skips occurred."""

        print_workflow_summary(
            [make_prepared_entry()],
            [
                SkippedEntry(
                    sha256="b" * 64,
                    source=Path("/tmp/missing.wav"),
                    reason="file not found",
                )
            ],
            [],
        )

        captured = capsys.readouterr()

        assert "All workflows completed successfully." not in captured.out
        assert "command will exit with status 1" in captured.out

    def test_keeps_success_message_for_resume_skips(self, capsys):
        """Skipping already-existing outputs still counts as a successful run."""

        print_workflow_summary(
            [make_prepared_entry()],
            [
                SkippedEntry(
                    sha256="c" * 64,
                    source=Path("/tmp/source.wav"),
                    reason=ALREADY_EXISTS_REASON,
                )
            ],
            [],
        )

        captured = capsys.readouterr()

        assert "All workflows completed successfully." in captured.out

    def test_collapses_resume_skips_into_a_count(self, capsys):
        """Re-runs report already-complete rows as one line, not one line per row."""

        print_workflow_summary(
            [],
            [
                SkippedEntry(
                    sha256=char * 64,
                    source=Path(f"/tmp/{char}.wav"),
                    reason=ALREADY_EXISTS_REASON,
                )
                for char in "abc"
            ],
            [],
        )

        captured = capsys.readouterr()

        assert f"3 already complete ({ALREADY_EXISTS_REASON})" in captured.out
        assert "--verbose-skips" in captured.out
        assert "a" * 64 not in captured.out

    def test_verbose_skips_lists_every_resume_skip(self, capsys):
        """The opt-in flag restores the full per-row listing."""

        print_workflow_summary(
            [],
            [
                SkippedEntry(
                    sha256=char * 64,
                    source=Path(f"/tmp/{char}.wav"),
                    reason=ALREADY_EXISTS_REASON,
                )
                for char in "abc"
            ],
            [],
            verbose_skips=True,
        )

        captured = capsys.readouterr()

        assert "already complete" not in captured.out
        for char in "abc":
            assert f"{char * 64}: {ALREADY_EXISTS_REASON}" in captured.out

    def test_error_skips_stay_listed_next_to_the_count(self, capsys):
        """Collapsing resume skips must not hide real errors."""

        print_workflow_summary(
            [],
            [
                SkippedEntry(
                    sha256="a" * 64,
                    source=Path("/tmp/source.wav"),
                    reason=ALREADY_EXISTS_REASON,
                ),
                SkippedEntry(
                    sha256="b" * 64,
                    source=Path("/tmp/missing.wav"),
                    reason="file not found",
                ),
            ],
            [],
        )

        captured = capsys.readouterr()

        assert "1 already complete" in captured.out
        assert f"{'b' * 64}: file not found" in captured.out
        assert "a" * 64 not in captured.out
