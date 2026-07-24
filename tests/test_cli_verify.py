"""Tests for transcript-validation log parsing and argument patterns.

Tests cover:
- Validation log parsing
- Argument parsing patterns
- CLI command structure
"""

from __future__ import annotations

import argparse
from pathlib import Path

from besedy.commands.catalog.validate import _parse_validation_log


class TestParseValidationLog:
    """Tests for _parse_validation_log function."""

    def test_parse_passed_validation(self):
        """Test parsing a successful validation log."""
        log = """
========================================
Validating: /path/to/transcript.json
Schema validation passed
Segments: 150, Words: 3500
NeMo validation passed
✓ All checks passed
========================================
"""
        result = _parse_validation_log(log)

        assert result["summary"]["target"] == "/path/to/transcript.json"
        assert result["summary"]["schema_passed"] is True
        assert result["summary"]["segments"] == 150
        assert result["summary"]["words"] == 3500
        assert result["summary"]["nemo_validation_passed"] is True
        assert result["summary"]["status"] == "passed"

    def test_parse_failed_validation(self):
        """Test parsing a failed validation log."""
        log = """
========================================
Validating: /path/to/transcript.json
Schema validation passed
Segments: 100, Words: 2000
NeMo validation failed (3 issue(s))
Validation failed with 3 issue(s)
========================================
"""
        result = _parse_validation_log(log)

        assert result["summary"]["schema_passed"] is True
        assert result["summary"]["nemo_validation_passed"] is False
        assert result["summary"]["status"] == "failed"
        assert result["summary"]["issue_count"] == 3

    def test_parse_minimal_log(self):
        """Test parsing a minimal log."""
        log = "Validating: /test/file.json"

        result = _parse_validation_log(log)

        assert result["summary"]["target"] == "/test/file.json"
        assert "steps" in result

    def test_steps_recorded(self):
        """Test that steps are recorded correctly."""
        log = """
Validating: /path/to/file.json
Schema validation passed
✓ All checks passed
"""
        result = _parse_validation_log(log)

        steps = result["steps"]
        step_names = [s["name"] for s in steps]

        assert "start" in step_names
        assert "schema" in step_names
        assert "complete" in step_names

    def test_empty_log(self):
        """Test parsing empty log."""
        result = _parse_validation_log("")

        assert result["summary"]["status"] == "unknown"
        assert result["steps"] == []

    def test_separator_lines_ignored(self):
        """Test that separator lines (===) are ignored."""
        log = """
========================================
Validating: /path/file.json
========================================
Schema validation passed
========================================
"""
        result = _parse_validation_log(log)

        # Should parse correctly despite separators
        assert result["summary"]["target"] == "/path/file.json"
        assert result["summary"]["schema_passed"] is True


class TestArgumentParsing:
    """Tests for CLI argument parsing patterns."""

    def test_validate_subcommand_args(self):
        """Test validate subcommand argument structure."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path, nargs="?", default=None)
        parser.add_argument("--limit", type=int, default=None)
        parser.add_argument("--verbose", "-v", action="store_true")
        parser.add_argument("--batch", action="store_true")
        parser.add_argument("--level", choices=["basic", "strict"], default="basic")
        parser.add_argument("--with-diarization", action="store_true")
        parser.add_argument("--json", action="store_true")

        # Test minimal args
        args = parser.parse_args([])
        assert args.input_path is None
        assert args.limit is None
        assert args.verbose is False

    def test_validate_with_path(self):
        """Test validate with input path."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path, nargs="?", default=None)
        parser.add_argument("--limit", type=int, default=None)

        args = parser.parse_args(["/path/to/transcripts"])
        assert args.input_path == Path("/path/to/transcripts")

    def test_validate_with_limit(self):
        """Test validate with limit option."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path, nargs="?", default=None)
        parser.add_argument("--limit", type=int, default=None)

        args = parser.parse_args(["--limit", "50", "/path"])
        assert args.limit == 50

    def test_validate_verbose_flag(self):
        """Test verbose flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path, nargs="?", default=None)
        parser.add_argument("--verbose", "-v", action="store_true")

        args = parser.parse_args(["-v"])
        assert args.verbose is True

    def test_validate_batch_flag(self):
        """Test batch flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("input_path", type=Path, nargs="?", default=None)
        parser.add_argument("--batch", action="store_true")

        args = parser.parse_args(["--batch"])
        assert args.batch is True

    def test_validate_level_choices(self):
        """Test validation level choices."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--level", choices=["basic", "strict"], default="basic")

        args = parser.parse_args(["--level", "strict"])
        assert args.level == "strict"

        args = parser.parse_args([])
        assert args.level == "basic"


class TestValidationResultStructure:
    """Tests for expected validation result structures."""

    def test_single_file_result_structure(self):
        """Test expected structure for single file validation."""
        # Simulate expected result structure
        result = {
            "mode": "single",
            "input_path": "/path/to/transcript.json",
            "passed": True,
            "elapsed_ms": 150,
        }

        assert result["mode"] == "single"
        assert "input_path" in result
        assert "passed" in result

    def test_batch_result_structure(self):
        """Test expected structure for batch validation."""
        result = {
            "mode": "batch",
            "input_path": "/path/to/transcripts",
            "limit": None,
            "verbose": False,
            "files_found": 100,
            "files_evaluated": 100,
            "passed": 95,
            "failed": 5,
        }

        assert result["mode"] == "batch"
        assert result["files_found"] == 100
        assert result["passed"] + result["failed"] == result["files_evaluated"]

    def test_batch_with_groups_structure(self):
        """Test batch result with group statistics."""
        result = {
            "mode": "batch",
            "groups": [
                {"name": "canary-nemo", "total": 50, "passed": 48, "failed": 2},
                {"name": "faster-whisper", "total": 50, "passed": 47, "failed": 3},
            ],
        }

        assert len(result["groups"]) == 2
        for group in result["groups"]:
            assert "name" in group
            assert "total" in group
            assert group["passed"] + group["failed"] == group["total"]

    def test_missing_file_result_structure(self):
        """Test result structure when file is missing."""
        result = {
            "mode": "missing",
            "error": "input_not_found",
            "input_path": "/nonexistent/path",
            "message": "Error: /nonexistent/path not found",
        }

        assert result["mode"] == "missing"
        assert result["error"] == "input_not_found"


class TestStepParsing:
    """Tests for validation step parsing."""

    def test_step_has_required_fields(self):
        """Test that parsed steps have required fields."""
        log = """
Validating: /path/file.json
Schema validation passed
"""
        result = _parse_validation_log(log)

        for step in result["steps"]:
            assert "name" in step
            assert "status" in step

    def test_failed_step_has_issues_count(self):
        """Test that failed steps include issue count."""
        log = """
Validating: /path/file.json
NeMo validation failed (5 issue(s))
"""
        result = _parse_validation_log(log)

        nemo_steps = [s for s in result["steps"] if s["name"] == "backend:nemo"]
        assert len(nemo_steps) == 1
        assert nemo_steps[0]["status"] == "failed"
        assert nemo_steps[0]["issues"] == 5


class TestEdgeCases:
    """Tests for edge cases."""

    def test_unicode_paths_in_log(self):
        """Test parsing logs with Unicode paths."""
        log = """
Validating: /cesta/k/příliš_žluťoučký/transcript.json
Schema validation passed
✓ All checks passed
"""
        result = _parse_validation_log(log)

        assert "žluťoučký" in result["summary"]["target"]
        assert result["summary"]["status"] == "passed"

    def test_very_long_paths(self):
        """Test parsing logs with very long paths."""
        long_path = "/very" + "/deep" * 50 + "/transcript.json"
        log = f"Validating: {long_path}\nSchema validation passed"

        result = _parse_validation_log(log)

        assert result["summary"]["target"] == long_path

    def test_large_segment_counts(self):
        """Test parsing logs with large segment counts."""
        log = """
Validating: /path/file.json
Schema validation passed
Segments: 999999, Words: 9999999
"""
        result = _parse_validation_log(log)

        assert result["summary"]["segments"] == 999999
        assert result["summary"]["words"] == 9999999

    def test_multiple_nemo_lines(self):
        """Test that only last NeMo status is captured."""
        log = """
Validating: /path/file.json
NeMo validation failed (2 issue(s))
NeMo validation passed
"""
        result = _parse_validation_log(log)

        # Last status should win
        assert result["summary"]["nemo_validation_passed"] is True
