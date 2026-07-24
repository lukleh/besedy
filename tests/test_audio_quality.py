"""Tests for besedy/lib/audio/quality.py.

Tests pure Python logic without requiring ffmpeg.
"""

from __future__ import annotations

from besedy.lib.audio.quality import (
    AUDIO_QUALITY_COLUMNS,
    AudioQualityMetrics,
    determine_needs_normalization,
    needs_declipping,
)


class TestNeedsDeclipping:
    """Tests for needs_declipping()."""

    def test_peak_at_threshold_needs_declipping(self):
        """Peak at exactly threshold needs declipping."""
        assert needs_declipping("-1.0", threshold=-1.0) is True

    def test_peak_above_threshold_needs_declipping(self):
        """Peak above threshold needs declipping."""
        assert needs_declipping("-0.5", threshold=-1.0) is True

    def test_peak_below_threshold_no_declipping(self):
        """Peak below threshold does not need declipping."""
        assert needs_declipping("-3.0", threshold=-1.0) is False

    def test_peak_well_below_threshold(self):
        """Well below threshold doesn't need declipping."""
        assert needs_declipping("-12.0", threshold=-1.0) is False

    def test_positive_peak_needs_declipping(self):
        """Positive peak (clipped) needs declipping."""
        assert needs_declipping("0.0", threshold=-1.0) is True
        assert needs_declipping("0.5", threshold=-1.0) is True

    def test_custom_threshold(self):
        """Custom threshold is respected."""
        # At -1.5 threshold, -1.0 needs declipping
        assert needs_declipping("-1.0", threshold=-1.5) is True
        # At -1.5 threshold, -2.0 doesn't need declipping
        assert needs_declipping("-2.0", threshold=-1.5) is False

    def test_empty_string_returns_false(self):
        """Empty string returns False."""
        assert needs_declipping("") is False

    def test_none_returns_false(self):
        """None returns False."""
        assert needs_declipping(None) is False

    def test_invalid_value_returns_false(self):
        """Invalid non-numeric value returns False."""
        assert needs_declipping("invalid") is False
        assert needs_declipping("N/A") is False


class TestDetermineNeedsNormalization:
    """Tests for determine_needs_normalization()."""

    def test_target_lufs_no_normalization(self):
        """-16 LUFS (target) doesn't need normalization."""
        assert determine_needs_normalization("-16.0") == "no"

    def test_in_range_no_normalization(self):
        """Values in -20 to -12 range don't need normalization."""
        assert determine_needs_normalization("-14.0") == "no"
        assert determine_needs_normalization("-18.0") == "no"
        assert determine_needs_normalization("-20.0") == "no"
        assert determine_needs_normalization("-12.0") == "no"

    def test_too_quiet_needs_normalization(self):
        """Too quiet (< -20 LUFS) needs normalization."""
        assert determine_needs_normalization("-25.0") == "yes"
        assert determine_needs_normalization("-30.0") == "yes"
        assert determine_needs_normalization("-20.1") == "yes"

    def test_too_loud_needs_normalization(self):
        """Too loud (> -12 LUFS) needs normalization."""
        assert determine_needs_normalization("-8.0") == "yes"
        assert determine_needs_normalization("-11.9") == "yes"
        assert determine_needs_normalization("-5.0") == "yes"

    def test_empty_string_returns_empty(self):
        """Empty string returns empty string."""
        assert determine_needs_normalization("") == ""

    def test_none_returns_empty(self):
        """None returns empty string."""
        assert determine_needs_normalization(None) == ""

    def test_invalid_value_returns_empty(self):
        """Invalid non-numeric value returns empty."""
        assert determine_needs_normalization("invalid") == ""
        assert determine_needs_normalization("N/A") == ""


class TestAudioQualityMetrics:
    """Tests for AudioQualityMetrics dataclass."""

    def test_default_values_empty(self):
        """All defaults are empty strings."""
        metrics = AudioQualityMetrics()
        assert metrics.integrated_loudness_lufs == ""
        assert metrics.true_peak_db == ""
        assert metrics.sample_rate == ""
        assert metrics.needs_normalization == ""

    def test_set_values(self):
        """Values can be set."""
        metrics = AudioQualityMetrics(
            integrated_loudness_lufs="-16.0",
            true_peak_db="-1.5",
            sample_rate="16000",
            channels="1",
        )
        assert metrics.integrated_loudness_lufs == "-16.0"
        assert metrics.true_peak_db == "-1.5"
        assert metrics.sample_rate == "16000"
        assert metrics.channels == "1"


class TestAudioQualityColumns:
    """Tests for AUDIO_QUALITY_COLUMNS constant."""

    def test_contains_expected_columns(self):
        """Contains all expected column names."""
        expected = [
            "sample_rate",
            "channels",
            "integrated_loudness_lufs",
            "true_peak_db",
            "needs_normalization",
        ]
        for col in expected:
            assert col in AUDIO_QUALITY_COLUMNS

    def test_excludes_deprecated_columns(self):
        """Deprecated columns are not in the constant."""
        deprecated = ["bit_depth", "mean_volume_db", "max_volume_db"]
        for col in deprecated:
            assert col not in AUDIO_QUALITY_COLUMNS

    def test_is_tuple(self):
        """Columns is a tuple (immutable)."""
        assert isinstance(AUDIO_QUALITY_COLUMNS, tuple)
