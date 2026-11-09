"""Tests for besedy/lib/workflow/common.py utilities."""

from __future__ import annotations

from pathlib import Path

import pytest

from besedy.lib.workflow.common import (
    CsvAudioRow,
    WorkflowCommand,
    iter_audio_csv_rows,
    parse_duration_to_seconds,
    resolve_unicode_path,
)


class TestParseDurationToSeconds:
    """Tests for parse_duration_to_seconds()."""

    @pytest.mark.parametrize(
        "value,expected",
        [
            ("00:01:30", 90),
            ("00:00:45", 45),
            ("01:30:00", 5400),
            ("01:02:03", 3723),
            ("100:00:00", 360000),
            ("  00:01:30  ", 90),
        ],
    )
    def test_canonical_duration(self, value, expected):
        assert parse_duration_to_seconds(value) == expected

    @pytest.mark.parametrize(
        "value",
        [
            "01:30",
            "00:45",
            "1:30:00",
            "00:30.5",
            "00:00:30.5",
            "90",
            "1:2:3:4",
            "ab:cd",
            "-1:00:00",
            "01:75:00",
            "00:00:60",
        ],
    )
    def test_rejects_noncanonical_duration(self, value):
        with pytest.raises(ValueError, match="HH:MM:SS"):
            parse_duration_to_seconds(value)

    @pytest.mark.parametrize("value", ["", "   "])
    def test_empty_duration(self, value):
        with pytest.raises(ValueError, match="empty"):
            parse_duration_to_seconds(value)

    def test_zero_duration(self):
        with pytest.raises(ValueError, match="positive"):
            parse_duration_to_seconds("00:00:00")


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


class TestIterAudioCsvRowsScanRoot:
    """Scan Root is carried on each row when the CSV has the column."""

    def test_reads_scan_root_per_row(self, tmp_path):
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            "Hash,Full Path,Scan Root,added_at\naaa,/data/a.mp3,/data,2026-01-01T00:00:00Z\nbbb,/uploads/b.m4a,,2026-01-01T00:00:00Z\n",
            encoding="utf-8",
        )
        rows = list(iter_audio_csv_rows(csv_path))
        assert [row.scan_root for row in rows] == ["/data", None]

    def test_missing_column_gives_none(self, tmp_path):
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text("Hash,Full Path,added_at\naaa,/data/a.mp3,2026-01-01T00:00:00Z\n", encoding="utf-8")
        rows = list(iter_audio_csv_rows(csv_path))
        assert rows[0].scan_root is None


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
