"""Tests for besedy/lib/audio/normalize.py and related types.

Tests cover:
- Audio processing constants and thresholds
- Data structures (PreparedEntry, SkippedEntry, ConversionResult)
- ManifestWriter for thread-safe CSV output
- format_size utility function
- Tolerance calculations

Note: Tests requiring FFmpeg are marked with @pytest.mark.integration.
"""

from __future__ import annotations

import csv

import pytest

from besedy.lib.audio.types import (
    DECLIP_THRESHOLD_DBTP,
    DURATION_TOLERANCE_MIN_SECONDS,
    DURATION_TOLERANCE_PERCENTAGE,
    FILESIZE_MISMATCH_DRIFT_TOLERANCE,
    LOUDNESS_ACCEPTABLE_MAX_LUFS,
    LOUDNESS_ACCEPTABLE_MIN_LUFS,
    LOUDNESS_RANGE_LU,
    LOUDNESS_TARGET_LUFS,
    NON_MONOTONIC_MAX_RATIO,
    NON_MONOTONIC_MIN_RATIO,
    STAGED_AUDIO_EXTENSION,
    TARGET_CHANNELS,
    TRUE_PEAK_TARGET_DBTP,
    ConversionLogMessage,
    ConversionResult,
    ManifestWriter,
    PreparedEntry,
    SkippedEntry,
    format_size,
)


class TestAudioConstants:
    """Tests for audio processing constants."""

    def test_target_channels_is_mono(self):
        """Verify target is mono (1 channel)."""
        assert TARGET_CHANNELS == 1

    def test_staged_extension_is_wav(self):
        """Verify staged files are WAV format."""
        assert STAGED_AUDIO_EXTENSION == ".wav"

    def test_loudness_target_is_broadcast_standard(self):
        """Verify loudness target is EBU R128 broadcast level."""
        assert LOUDNESS_TARGET_LUFS == -16

    def test_loudness_acceptable_range(self):
        """Verify acceptable loudness range is ±4 LUFS from target."""
        assert LOUDNESS_ACCEPTABLE_MIN_LUFS == -20
        assert LOUDNESS_ACCEPTABLE_MAX_LUFS == -12
        # Range should be symmetric around target
        target = LOUDNESS_TARGET_LUFS
        assert LOUDNESS_ACCEPTABLE_MIN_LUFS == target - 4
        assert LOUDNESS_ACCEPTABLE_MAX_LUFS == target + 4

    def test_loudness_range_lu(self):
        """Verify loudness range target."""
        assert LOUDNESS_RANGE_LU == 11

    def test_true_peak_target(self):
        """Verify true peak is below 0 dBFS with headroom."""
        assert TRUE_PEAK_TARGET_DBTP == -1.5
        assert TRUE_PEAK_TARGET_DBTP < 0  # Must be below full scale

    def test_declip_threshold(self):
        """Verify declip threshold is at EBU R128 limit."""
        assert DECLIP_THRESHOLD_DBTP == -1.0

    def test_duration_tolerances(self):
        """Verify duration tolerance values."""
        assert DURATION_TOLERANCE_MIN_SECONDS == 0.25
        assert DURATION_TOLERANCE_PERCENTAGE == 0.02

    def test_filesize_mismatch_tolerance(self):
        """Verify filesize mismatch tolerance for container formats."""
        assert FILESIZE_MISMATCH_DRIFT_TOLERANCE == 0.10

    def test_non_monotonic_ratios(self):
        """Verify non-monotonic DTS tolerance range."""
        assert NON_MONOTONIC_MIN_RATIO == 0.5
        assert NON_MONOTONIC_MAX_RATIO == 2.5


class TestDurationToleranceCalculation:
    """Tests for duration tolerance calculation logic."""

    def test_tolerance_for_short_file_uses_minimum(self):
        """Test that short files use minimum tolerance."""
        duration = 5.0  # 5 seconds
        percent_tolerance = duration * DURATION_TOLERANCE_PERCENTAGE  # 0.1s
        actual_tolerance = max(DURATION_TOLERANCE_MIN_SECONDS, percent_tolerance)
        assert actual_tolerance == DURATION_TOLERANCE_MIN_SECONDS

    def test_tolerance_for_long_file_uses_percentage(self):
        """Test that long files use percentage tolerance."""
        duration = 60.0  # 60 seconds
        percent_tolerance = duration * DURATION_TOLERANCE_PERCENTAGE  # 1.2s
        actual_tolerance = max(DURATION_TOLERANCE_MIN_SECONDS, percent_tolerance)
        assert actual_tolerance == percent_tolerance
        assert actual_tolerance == 1.2

    def test_tolerance_crossover_point(self):
        """Test the crossover point where percentage equals minimum."""
        # At 12.5 seconds, 2% = 0.25s = minimum
        crossover_duration = DURATION_TOLERANCE_MIN_SECONDS / DURATION_TOLERANCE_PERCENTAGE
        assert crossover_duration == 12.5


class TestPreparedEntry:
    """Tests for PreparedEntry dataclass."""

    def test_basic_creation(self, tmp_path):
        """Test creating a PreparedEntry."""
        source = tmp_path / "source.wav"
        staged = tmp_path / "staged.wav"

        entry = PreparedEntry(
            sha256="abc123def456",
            source=source,
            staged=staged,
            action="convert",
            duration_seconds=90.5,
        )

        assert entry.sha256 == "abc123def456"
        assert entry.source == source
        assert entry.staged == staged
        assert entry.action == "convert"
        assert entry.duration_seconds == 90.5
        assert entry.normalized is False  # Default

    def test_with_normalization_flag(self, tmp_path):
        """Test PreparedEntry with normalization flag."""
        source = tmp_path / "source.wav"
        staged = tmp_path / "staged.wav"

        entry = PreparedEntry(
            sha256="abc123",
            source=source,
            staged=staged,
            action="convert",
            duration_seconds=60.0,
            normalized=True,
        )

        assert entry.normalized is True

    def test_is_frozen(self, tmp_path):
        """Test that PreparedEntry is immutable."""
        entry = PreparedEntry(
            sha256="abc",
            source=tmp_path / "s.wav",
            staged=tmp_path / "t.wav",
            action="symlink",
            duration_seconds=10.0,
        )

        with pytest.raises(AttributeError):
            entry.sha256 = "changed"

    def test_action_types(self, tmp_path):
        """Test different action types."""
        source = tmp_path / "source.wav"
        staged = tmp_path / "staged.wav"

        for action in ["symlink", "convert", "existing"]:
            entry = PreparedEntry(
                sha256="hash",
                source=source,
                staged=staged,
                action=action,
                duration_seconds=30.0,
            )
            assert entry.action == action


class TestSkippedEntry:
    """Tests for SkippedEntry dataclass."""

    def test_basic_creation(self, tmp_path):
        """Test creating a SkippedEntry."""
        source = tmp_path / "missing.wav"

        entry = SkippedEntry(
            sha256="def789",
            source=source,
            reason="file not found",
        )

        assert entry.sha256 == "def789"
        assert entry.source == source
        assert entry.reason == "file not found"

    def test_is_frozen(self, tmp_path):
        """Test that SkippedEntry is immutable."""
        entry = SkippedEntry(
            sha256="abc",
            source=tmp_path / "s.wav",
            reason="test",
        )

        with pytest.raises(AttributeError):
            entry.reason = "changed"

    def test_common_skip_reasons(self, tmp_path):
        """Test common skip reasons."""
        source = tmp_path / "file.wav"

        reasons = [
            "file not found",
            "duplicate hash in CSV",
            "conversion failed",
            "invalid format",
        ]

        for reason in reasons:
            entry = SkippedEntry(sha256="hash", source=source, reason=reason)
            assert entry.reason == reason


class TestConversionLogMessage:
    """Tests for ConversionLogMessage dataclass."""

    def test_basic_message(self):
        """Test creating a basic log message."""
        msg = ConversionLogMessage(text="Processing file...")
        assert msg.text == "Processing file..."
        assert msg.is_error is False

    def test_error_message(self):
        """Test creating an error log message."""
        msg = ConversionLogMessage(text="Failed to convert", is_error=True)
        assert msg.text == "Failed to convert"
        assert msg.is_error is True

    def test_is_frozen(self):
        """Test that ConversionLogMessage is immutable."""
        msg = ConversionLogMessage(text="test")
        with pytest.raises(AttributeError):
            msg.text = "changed"


class TestConversionResult:
    """Tests for ConversionResult dataclass."""

    def test_successful_result(self, tmp_path):
        """Test creating a successful conversion result."""
        entry = PreparedEntry(
            sha256="abc",
            source=tmp_path / "s.wav",
            staged=tmp_path / "t.wav",
            action="convert",
            duration_seconds=60.0,
        )

        result = ConversionResult(
            prepared=entry,
            skipped=None,
            messages=[ConversionLogMessage("Done")],
            log_lines=["Line 1", "Line 2"],
            size_bytes=1024000,
        )

        assert result.prepared is not None
        assert result.skipped is None
        assert len(result.messages) == 1
        assert result.size_bytes == 1024000

    def test_skipped_result(self, tmp_path):
        """Test creating a skipped conversion result."""
        skipped = SkippedEntry(
            sha256="def",
            source=tmp_path / "missing.wav",
            reason="file not found",
        )

        result = ConversionResult(
            prepared=None,
            skipped=skipped,
            messages=[ConversionLogMessage("Skipped", is_error=True)],
            log_lines=[],
        )

        assert result.prepared is None
        assert result.skipped is not None
        assert result.metrics is None
        assert result.size_bytes == 0  # Default


class TestFormatSize:
    """Tests for format_size utility function."""

    def test_bytes(self):
        """Test formatting bytes."""
        assert format_size(0) == "0 B"
        assert format_size(1) == "1 B"
        assert format_size(512) == "512 B"
        assert format_size(1023) == "1023 B"

    def test_kilobytes(self):
        """Test formatting kilobytes."""
        assert format_size(1024) == "1.0 KB"
        assert format_size(1536) == "1.5 KB"
        assert format_size(2048) == "2.0 KB"

    def test_megabytes(self):
        """Test formatting megabytes."""
        assert format_size(1024 * 1024) == "1.0 MB"
        assert format_size(1024 * 1024 * 1.5) == "1.5 MB"
        assert format_size(1024 * 1024 * 10) == "10.0 MB"

    def test_gigabytes(self):
        """Test formatting gigabytes."""
        assert format_size(1024**3) == "1.0 GB"
        assert format_size(1024**3 * 2.5) == "2.5 GB"

    def test_terabytes(self):
        """Test formatting terabytes."""
        assert format_size(1024**4) == "1.0 TB"

    def test_negative_returns_zero(self):
        """Test that negative values return 0 B."""
        assert format_size(-100) == "0 B"

    def test_large_values(self):
        """Test formatting large values."""
        # 100 GB
        assert format_size(100 * 1024**3) == "100.0 GB"

    def test_precision(self):
        """Test decimal precision is 1 place."""
        result = format_size(1536 * 1024)  # 1.5 MB
        assert result == "1.5 MB"


class TestManifestWriter:
    """Tests for ManifestWriter class."""

    def test_creates_csv_with_header(self, tmp_path):
        """Test that manifest creates CSV with headers."""
        manifest_path = tmp_path / "manifest.csv"

        writer = ManifestWriter(manifest_path, include_analysis=False)
        writer.close()

        # Read and verify headers
        with manifest_path.open() as f:
            reader = csv.reader(f)
            headers = next(reader)

        assert "Hash" in headers
        assert "Full Path" in headers
        assert "Filename" in headers
        assert "Size (bytes)" in headers
        assert "Size (human)" in headers

    def test_creates_parent_directories(self, tmp_path):
        """Test that manifest creates parent directories if needed."""
        manifest_path = tmp_path / "subdir" / "nested" / "manifest.csv"

        writer = ManifestWriter(manifest_path, include_analysis=False)
        writer.close()

        assert manifest_path.exists()

    def test_write_entry(self, tmp_path):
        """Test writing an entry to the manifest."""
        manifest_path = tmp_path / "manifest.csv"
        staged = tmp_path / "staged.wav"
        staged.touch()

        entry = PreparedEntry(
            sha256="abc123def456",
            source=tmp_path / "source.wav",
            staged=staged,
            action="convert",
            duration_seconds=60.0,
        )

        writer = ManifestWriter(manifest_path, include_analysis=False)
        writer.write_entry(entry, size_bytes=1024000)
        writer.close()

        # Read and verify entry
        with manifest_path.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 1
        assert rows[0]["Hash"] == "abc123def456"
        assert rows[0]["Filename"] == "staged.wav"
        assert rows[0]["Size (bytes)"] == "1024000"

    def test_write_multiple_entries(self, tmp_path):
        """Test writing multiple entries."""
        manifest_path = tmp_path / "manifest.csv"

        writer = ManifestWriter(manifest_path, include_analysis=False)

        for i in range(3):
            staged = tmp_path / f"staged_{i}.wav"
            staged.touch()

            entry = PreparedEntry(
                sha256=f"hash{i}",
                source=tmp_path / f"source_{i}.wav",
                staged=staged,
                action="convert",
                duration_seconds=30.0 * (i + 1),
            )
            writer.write_entry(entry, size_bytes=1000 * (i + 1))

        writer.close()

        with manifest_path.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 3
        assert rows[0]["Hash"] == "hash0"
        assert rows[1]["Hash"] == "hash1"
        assert rows[2]["Hash"] == "hash2"

    def test_thread_safety(self, tmp_path):
        """Test that ManifestWriter is thread-safe."""
        import threading

        manifest_path = tmp_path / "manifest.csv"
        writer = ManifestWriter(manifest_path, include_analysis=False)

        def write_entry(idx):
            staged = tmp_path / f"staged_{idx}.wav"
            staged.touch()

            entry = PreparedEntry(
                sha256=f"hash{idx}",
                source=tmp_path / f"source_{idx}.wav",
                staged=staged,
                action="convert",
                duration_seconds=60.0,
            )
            writer.write_entry(entry, size_bytes=1024)

        threads = [threading.Thread(target=write_entry, args=(i,)) for i in range(10)]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        writer.close()

        with manifest_path.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        # All 10 entries should be written
        assert len(rows) == 10


class TestLoudnessValidation:
    """Tests for loudness validation logic."""

    def test_loudness_in_acceptable_range(self):
        """Test loudness values within acceptable range."""
        min_lufs = LOUDNESS_ACCEPTABLE_MIN_LUFS
        max_lufs = LOUDNESS_ACCEPTABLE_MAX_LUFS

        # Target should be in range
        assert min_lufs <= LOUDNESS_TARGET_LUFS <= max_lufs

        # Test boundary values
        assert min_lufs <= -20 <= max_lufs  # Lower bound
        assert min_lufs <= -12 <= max_lufs  # Upper bound
        assert min_lufs <= -16 <= max_lufs  # Target

    def test_loudness_outside_range(self):
        """Test loudness values outside acceptable range."""
        min_lufs = LOUDNESS_ACCEPTABLE_MIN_LUFS
        max_lufs = LOUDNESS_ACCEPTABLE_MAX_LUFS

        # Too quiet
        assert -25 < min_lufs
        assert not (min_lufs <= -25 <= max_lufs)

        # Too loud
        assert -8 > max_lufs
        assert not (min_lufs <= -8 <= max_lufs)


class TestStageAudioFilesReuseExisting:
    """Tests for reusing staged files without source re-conversion."""

    def test_reuses_existing_staged_file_when_source_is_missing(self, tmp_path):
        """Incremental runs should reuse existing staged WAVs even if source files vanished."""

        from besedy.lib.audio.normalize import stage_audio_files
        from besedy.lib.workflow.common import CsvAudioRow

        sha256 = "a" * 64
        missing_source = tmp_path / "missing.mp3"
        staging_dir = tmp_path / "staging"
        staging_dir.mkdir()
        staged_path = staging_dir / f"{sha256}.wav"
        staged_path.write_bytes(b"RIFFtest")

        manifest_path = tmp_path / "manifest.csv"
        manifest = ManifestWriter(manifest_path, include_analysis=False)

        prepared, skipped = stage_audio_files(
            rows=[
                CsvAudioRow(
                    sha256=sha256,
                    full_path=str(missing_source),
                    duration_seconds=1.0,
                )
            ],
            staging_dir=staging_dir,
            manifest_writer=manifest,
            include_audio_analysis=False,
            analysis_ffmpeg="ffmpeg",
            analysis_ffprobe="ffprobe",
            continue_on_error=True,
            reuse_existing=True,
        )

        manifest.close()

        assert len(prepared) == 1
        assert len(skipped) == 0
        assert prepared[0].action == "existing"
        assert prepared[0].source == missing_source
        assert prepared[0].staged == staged_path

        with manifest_path.open() as handle:
            rows = list(csv.DictReader(handle))

        assert len(rows) == 1
        assert rows[0]["Hash"] == sha256
        assert rows[0]["Full Path"] == str(staged_path)


@pytest.mark.integration
class TestStageAudioFilesIntegration:
    """Integration tests requiring FFmpeg.

    These tests are skipped unless FFmpeg is available.
    """

    def test_stage_single_file(self, tmp_path, require_ffmpeg, wav_16k_mono):
        """Test staging a single audio file."""
        from besedy.lib.audio.normalize import stage_audio_files
        from besedy.lib.workflow.common import CsvAudioRow

        # Create test row
        row = CsvAudioRow(
            sha256="a" * 64,
            full_path=str(wav_16k_mono),
            duration_seconds=1.0,
        )

        staging_dir = tmp_path / "staging"
        staging_dir.mkdir()

        manifest_path = tmp_path / "manifest.csv"
        manifest = ManifestWriter(manifest_path, include_analysis=False)

        prepared, skipped = stage_audio_files(
            rows=[row],
            staging_dir=staging_dir,
            manifest_writer=manifest,
            include_audio_analysis=False,
            analysis_ffmpeg="ffmpeg",
            analysis_ffprobe="ffprobe",
            continue_on_error=True,
            reuse_existing=False,
        )

        manifest.close()

        assert len(prepared) == 1
        assert len(skipped) == 0
        assert prepared[0].staged.exists()
