"""Tests for the archive command module."""

from __future__ import annotations

import csv
import tempfile
from pathlib import Path

import pytest

from besedy.commands.catalog.archive import (
    M4A_VBR_MODES,
    OPUS_BITRATES,
    OPUS_SUPPORTED_RATES,
    ArchivedManifestWriter,
    ArchiveSkippedEntry,
    CompressedEntry,
    compute_output_path,
    nearest_opus_sample_rate,
)


class TestNearestOpusSampleRate:
    """Tests for Opus sample rate rounding."""

    def test_exact_supported_rates_unchanged(self):
        """Exact Opus-supported rates should remain unchanged."""
        for rate in OPUS_SUPPORTED_RATES:
            assert nearest_opus_sample_rate(rate) == rate

    def test_44100_caps_at_24000(self):
        """44.1kHz (CD quality) should cap at 24kHz for speech."""
        assert nearest_opus_sample_rate(44100) == 24000

    def test_22050_rounds_to_24000(self):
        """22.05kHz should round to 24kHz."""
        assert nearest_opus_sample_rate(22050) == 24000

    def test_11025_rounds_to_12000(self):
        """11.025kHz should round to 12kHz."""
        assert nearest_opus_sample_rate(11025) == 12000

    def test_high_rates_cap_at_24000(self):
        """Rates above 24kHz should cap at 24kHz for speech."""
        assert nearest_opus_sample_rate(48000) == 24000
        assert nearest_opus_sample_rate(96000) == 24000
        assert nearest_opus_sample_rate(192000) == 24000

    def test_very_low_rates_floor_at_8000(self):
        """Very low rates should floor at 8kHz."""
        assert nearest_opus_sample_rate(4000) == 8000
        assert nearest_opus_sample_rate(6000) == 8000

    def test_boundary_cases(self):
        """Test boundary values between supported rates."""
        # Between 8000 and 12000 - boundary at 10000
        assert nearest_opus_sample_rate(9000) == 8000
        assert nearest_opus_sample_rate(11000) == 12000

        # Between 12000 and 16000 - boundary at 14000
        assert nearest_opus_sample_rate(13000) == 12000
        assert nearest_opus_sample_rate(15000) == 16000

        # Between 16000 and 24000 - boundary at 20000
        assert nearest_opus_sample_rate(18000) == 16000
        assert nearest_opus_sample_rate(22000) == 24000

        # Above 24000 - caps at 24000 for speech
        assert nearest_opus_sample_rate(30000) == 24000
        assert nearest_opus_sample_rate(40000) == 24000


class TestComputeOutputPath:
    """Tests for output path computation."""

    def test_preserves_directory_structure(self):
        """Output path should preserve source directory structure with hash suffix."""
        source = Path("/data/podcasts/2024/episode1.mp3")
        source_root = Path("/data")
        output_dir = Path("/archive")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        # Hash suffix (first 8 chars) is added to filename
        assert result == Path("/archive/podcasts/2024/episode1_abc12345.webm")

    def test_changes_extension(self):
        """Output should have the new extension."""
        source = Path("/audio/file.mp3")
        source_root = Path("/audio")
        output_dir = Path("/out")
        sha256 = "abc12345def67890"

        webm_result = compute_output_path(source, source_root, output_dir, ".webm", sha256)
        assert webm_result.suffix == ".webm"

        m4a_result = compute_output_path(source, source_root, output_dir, ".m4a", sha256)
        assert m4a_result.suffix == ".m4a"

    def test_handles_deep_paths(self):
        """Should handle deeply nested paths."""
        source = Path("/a/b/c/d/e/f/file.wav")
        source_root = Path("/a")
        output_dir = Path("/out")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        assert result == Path("/out/b/c/d/e/f/file_abc12345.webm")

    def test_handles_spaces_in_path(self):
        """Should handle paths with spaces."""
        source = Path("/my files/podcast episodes/episode 1.mp3")
        source_root = Path("/my files")
        output_dir = Path("/archive")
        sha256 = "abc12345def67890"
        result = compute_output_path(source, source_root, output_dir, ".webm", sha256)

        assert result == Path("/archive/podcast episodes/episode 1_abc12345.webm")
        assert "podcast episodes" in str(result)
        assert result.name == "episode 1_abc12345.webm"


class TestArchivedManifestWriter:
    """Tests for the CSV manifest writer."""

    def test_writes_header(self):
        """Manifest should have correct header row."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            path = Path(f.name)

        try:
            writer = ArchivedManifestWriter(path)
            writer.close()

            with open(path, "r", encoding="utf-8") as f:
                reader = csv.reader(f)
                header = next(reader)

            expected = [
                "Hash",
                "Original Path",
                "Compressed Path",
                "Format",
                "Bitrate (kbps)",
                "Original Size (bytes)",
                "Compressed Size (bytes)",
                "Compression Ratio",
                "Duration",
                "added_at",
            ]
            assert header == expected
        finally:
            path.unlink(missing_ok=True)

    def test_writes_entry(self):
        """Should write entry data correctly."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".csv", delete=False) as f:
            path = Path(f.name)

        try:
            writer = ArchivedManifestWriter(path)

            entry = CompressedEntry(
                sha256="abc123",
                source=Path("/src/file.mp3"),
                compressed=Path("/out/file.webm"),
                format="opus",
                bitrate_kbps=48,
                source_size_bytes=1000000,
                compressed_size_bytes=500000,
                compression_ratio=2.0,
                duration_seconds=3661,  # 1:01:01
            )
            writer.write_entry(entry)
            writer.close()

            with open(path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                row = next(reader)

            assert row["Hash"] == "abc123"
            assert row["Original Path"] == "/src/file.mp3"
            assert row["Compressed Path"] == "/out/file.webm"
            assert row["Format"] == "opus"
            assert row["Bitrate (kbps)"] == "48"
            assert row["Original Size (bytes)"] == "1000000"
            assert row["Compressed Size (bytes)"] == "500000"
            assert row["Compression Ratio"] == "2.0"
            assert row["Duration"] == "01:01:01"
        finally:
            path.unlink(missing_ok=True)


class TestDataclasses:
    """Tests for dataclass definitions."""

    def test_compressed_entry_immutable(self):
        """CompressedEntry should be immutable (frozen)."""
        entry = CompressedEntry(
            sha256="abc",
            source=Path("/a"),
            compressed=Path("/b"),
            format="opus",
            bitrate_kbps=48,
            source_size_bytes=100,
            compressed_size_bytes=50,
            compression_ratio=2.0,
            duration_seconds=60,
        )
        with pytest.raises(AttributeError):
            entry.sha256 = "xyz"

    def test_skipped_entry_immutable(self):
        """ArchiveSkippedEntry should be immutable (frozen)."""
        entry = ArchiveSkippedEntry(
            sha256="abc",
            source=Path("/a"),
            reason="test reason",
        )
        with pytest.raises(AttributeError):
            entry.reason = "new reason"


class TestConstants:
    """Tests for module constants."""

    def test_opus_bitrates_has_all_presets(self):
        """OPUS_BITRATES should have all quality presets."""
        assert set(OPUS_BITRATES.keys()) == {"low", "medium", "high", "max"}

    def test_opus_bitrates_ascending(self):
        """Bitrates should increase with quality."""
        assert OPUS_BITRATES["low"] < OPUS_BITRATES["medium"]
        assert OPUS_BITRATES["medium"] < OPUS_BITRATES["high"]
        assert OPUS_BITRATES["high"] < OPUS_BITRATES["max"]

    def test_m4a_vbr_modes_has_all_presets(self):
        """M4A_VBR_MODES should have all quality presets."""
        assert set(M4A_VBR_MODES.keys()) == {"low", "medium", "high", "max"}

    def test_opus_supported_rates_sorted(self):
        """OPUS_SUPPORTED_RATES should be sorted ascending."""
        assert OPUS_SUPPORTED_RATES == sorted(OPUS_SUPPORTED_RATES)

    def test_opus_supported_rates_values(self):
        """OPUS_SUPPORTED_RATES should be capped at 24kHz for speech archiving."""
        assert OPUS_SUPPORTED_RATES == [8000, 12000, 16000, 24000]
