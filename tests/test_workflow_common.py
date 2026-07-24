"""Tests for besedy/lib/workflow/common.py utilities."""

from __future__ import annotations

from pathlib import Path

import pytest

from besedy.lib.workflow.common import (
    CsvAudioRow,
    WorkflowCommand,
    parse_duration_to_seconds,
    resolve_unicode_path,
)


class TestParseDurationToSeconds:
    """Tests for parse_duration_to_seconds()."""

    # Valid formats
    def test_mm_ss_format(self):
        assert parse_duration_to_seconds("01:30") == 90.0

    def test_mm_ss_zero_minutes(self):
        assert parse_duration_to_seconds("00:45") == 45.0

    def test_hh_mm_ss_format(self):
        assert parse_duration_to_seconds("1:30:00") == 5400.0

    def test_hh_mm_ss_with_leading_zeros(self):
        assert parse_duration_to_seconds("01:02:03") == 3723.0

    def test_fractional_seconds(self):
        result = parse_duration_to_seconds("00:30.5")
        assert result == pytest.approx(30.5)

    def test_large_duration(self):
        # 10 hours
        result = parse_duration_to_seconds("10:00:00")
        assert result == 36000.0

    def test_whitespace_stripped(self):
        result = parse_duration_to_seconds("  01:30  ")
        assert result == 90.0

    # Error cases
    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="empty"):
            parse_duration_to_seconds("")

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match="empty"):
            parse_duration_to_seconds("   ")

    def test_no_colon_raises(self):
        with pytest.raises(ValueError, match="MM:SS or HH:MM:SS"):
            parse_duration_to_seconds("90")

    def test_too_many_colons_raises(self):
        with pytest.raises(ValueError, match="MM:SS or HH:MM:SS"):
            parse_duration_to_seconds("1:2:3:4")

    def test_non_numeric_raises(self):
        with pytest.raises(ValueError, match="non-numeric"):
            parse_duration_to_seconds("ab:cd")

    def test_negative_hours_raises(self):
        with pytest.raises(ValueError, match="negative"):
            parse_duration_to_seconds("-1:00:00")

    def test_negative_minutes_raises(self):
        with pytest.raises(ValueError, match="negative"):
            parse_duration_to_seconds("-01:30")

    def test_seconds_over_60_raises(self):
        with pytest.raises(ValueError, match="out of range"):
            parse_duration_to_seconds("01:75")

    def test_minutes_over_60_with_hours_raises(self):
        with pytest.raises(ValueError, match="out of range"):
            parse_duration_to_seconds("1:75:00")

    def test_zero_duration_raises(self):
        with pytest.raises(ValueError, match="positive"):
            parse_duration_to_seconds("00:00")


class TestResolveUnicodePath:
    """Tests for resolve_unicode_path()."""

    def test_existing_path_found(self, tmp_path):
        test_file = tmp_path / "test.wav"
        test_file.touch()

        path, original, exists = resolve_unicode_path(str(test_file))
        assert exists is True
        assert path.exists()

    def test_nonexistent_path_returns_false(self):
        path, original, exists = resolve_unicode_path("/nonexistent/path.wav")
        assert exists is False

    def test_nfc_normalization_tried(self, tmp_path):
        # Create file with NFC-normalized name
        test_file = tmp_path / "test_file.wav"
        test_file.touch()

        # Should find it even if we ask with the same string
        path, original, exists = resolve_unicode_path(str(test_file))
        assert exists is True

    def test_returns_path_object(self, tmp_path):
        test_file = tmp_path / "audio.wav"
        test_file.touch()

        path, original, exists = resolve_unicode_path(str(test_file))
        assert isinstance(path, Path)


class TestCsvAudioRow:
    """Tests for CsvAudioRow dataclass."""

    def test_basic_creation(self):
        row = CsvAudioRow(sha256="abc123", full_path="/path/to/audio.wav")
        assert row.sha256 == "abc123"
        assert row.full_path == "/path/to/audio.wav"
        assert row.duration_seconds is None

    def test_with_duration(self):
        row = CsvAudioRow(
            sha256="abc123",
            full_path="/path/to/audio.wav",
            duration_seconds=90.5,
        )
        assert row.duration_seconds == 90.5

    def test_with_loudness_params(self):
        row = CsvAudioRow(
            sha256="abc123",
            full_path="/path/to/audio.wav",
            integrated_loudness_lufs="-16.0",
            true_peak_db="-1.5",
        )
        assert row.integrated_loudness_lufs == "-16.0"
        assert row.true_peak_db == "-1.5"

    def test_is_frozen(self):
        row = CsvAudioRow(sha256="abc", full_path="/test")
        with pytest.raises(AttributeError):
            row.sha256 = "changed"


class TestWorkflowCommand:
    """Tests for WorkflowCommand dataclass."""

    def test_basic_creation(self):
        cmd = WorkflowCommand(
            label="test-workflow",
            argv=["python", "script.py", "--arg"],
        )
        assert cmd.label == "test-workflow"
        assert cmd.argv == ["python", "script.py", "--arg"]
        assert cmd.extra_env is None
        assert cmd.parallel_group is None

    def test_with_extra_env(self):
        cmd = WorkflowCommand(
            label="gpu-workflow",
            argv=["python", "transcribe.py"],
            extra_env={"CUDA_VISIBLE_DEVICES": "0"},
        )
        assert cmd.extra_env == {"CUDA_VISIBLE_DEVICES": "0"}

    def test_with_parallel_group(self):
        cmd = WorkflowCommand(
            label="nemo-transcribe",
            argv=["python", "transcribe_nemo.py"],
            parallel_group="gpu",
        )
        assert cmd.parallel_group == "gpu"

    def test_is_frozen(self):
        cmd = WorkflowCommand(label="test", argv=["echo"])
        with pytest.raises(AttributeError):
            cmd.label = "changed"
