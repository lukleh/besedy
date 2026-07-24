"""Tests for besedy/lib/speakers/utils.py.

Tests cover:
- Timestamp rounding
- Segment key generation
- Segments checksum computation
- Diarization JSON loading
- HuggingFace token retrieval
"""

from __future__ import annotations

import json
import sys
import types

import pytest

from besedy.lib.speakers.utils import (
    compute_segments_checksum,
    get_hf_token,
    load_diarization_json,
    round_time,
    segment_key,
)


@pytest.fixture
def huggingface_hub_stub(monkeypatch: pytest.MonkeyPatch) -> types.ModuleType:
    """Provide the small Hugging Face API surface used by ``get_hf_token``."""
    module = types.ModuleType("huggingface_hub")
    module.get_token = lambda: None  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", module)
    return module


class TestRoundTime:
    """Tests for round_time function."""

    def test_rounds_to_three_decimals(self):
        """Test rounding to 3 decimal places."""
        assert round_time(1.23456789) == 1.235
        assert round_time(0.1234) == 0.123
        assert round_time(10.9999) == 11.0

    def test_handles_integer(self):
        """Test handling integer input."""
        assert round_time(5) == 5.0
        assert round_time(0) == 0.0

    def test_handles_string_numeric(self):
        """Test handling string numeric input."""
        assert round_time("1.234") == 1.234
        assert round_time("10") == 10.0

    def test_negative_values(self):
        """Test negative values."""
        assert round_time(-1.23456) == -1.235


class TestSegmentKey:
    """Tests for segment_key function."""

    def test_creates_tuple(self):
        """Test that segment_key creates a tuple."""
        key = segment_key("SPEAKER_00", 1.234567, 5.678901)
        assert key == ("SPEAKER_00", 1.235, 5.679)

    def test_speaker_preserved(self):
        """Test speaker identifier is preserved."""
        key = segment_key("CustomSpeaker", 0.0, 1.0)
        assert key[0] == "CustomSpeaker"

    def test_consistent_rounding(self):
        """Test consistent rounding behavior."""
        # Rounding to 3 decimal places
        key1 = segment_key("SPK", 1.2345, 2.3455)
        key2 = segment_key("SPK", 1.2345, 2.3455)
        assert key1 == key2  # Same values round identically


class TestComputeSegmentsChecksum:
    """Tests for compute_segments_checksum function."""

    def test_identical_segments_same_checksum(self):
        """Test identical segments produce same checksum."""
        segments1 = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.5},
            {"speaker": "SPEAKER_01", "start": 1.5, "end": 3.0},
        ]
        segments2 = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.5},
            {"speaker": "SPEAKER_01", "start": 1.5, "end": 3.0},
        ]
        assert compute_segments_checksum(segments1) == compute_segments_checksum(segments2)

    def test_different_segments_different_checksum(self):
        """Test different segments produce different checksums."""
        segments1 = [{"speaker": "SPEAKER_00", "start": 0.0, "end": 1.5}]
        segments2 = [{"speaker": "SPEAKER_00", "start": 0.0, "end": 2.0}]  # Different end
        assert compute_segments_checksum(segments1) != compute_segments_checksum(segments2)

    def test_order_matters(self):
        """Test that segment order affects checksum."""
        segments1 = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0},
            {"speaker": "SPEAKER_01", "start": 1.0, "end": 2.0},
        ]
        segments2 = [
            {"speaker": "SPEAKER_01", "start": 1.0, "end": 2.0},
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0},
        ]
        assert compute_segments_checksum(segments1) != compute_segments_checksum(segments2)

    def test_rounding_applied(self):
        """Test that rounding is applied to timestamps."""
        # Values that round to exactly the same 3 decimal places
        segments1 = [{"speaker": "SPK", "start": 0.1234, "end": 1.5678}]
        segments2 = [
            {"speaker": "SPK", "start": 0.12340001, "end": 1.56780001}
        ]  # Same after rounding
        assert compute_segments_checksum(segments1) == compute_segments_checksum(segments2)

    def test_empty_segments(self):
        """Test empty segments list."""
        checksum = compute_segments_checksum([])
        assert isinstance(checksum, str)
        assert len(checksum) > 0

    def test_missing_fields_handled(self):
        """Test segments with missing fields use defaults."""
        segments = [{"speaker": "SPK"}]  # Missing start and end
        checksum = compute_segments_checksum(segments)
        assert isinstance(checksum, str)


class TestLoadDiarizationJson:
    """Tests for load_diarization_json function."""

    def test_load_valid_json(self, tmp_path):
        """Test loading valid diarization JSON."""
        json_path = tmp_path / "speakers.json"
        data = {
            "audio_file": "/path/to/audio.wav",
            "segments": [
                {"speaker": "SPEAKER_00", "start": 0.0, "end": 1.5},
            ],
        }
        json_path.write_text(json.dumps(data))

        result = load_diarization_json(json_path)
        assert result["audio_file"] == "/path/to/audio.wav"
        assert len(result["segments"]) == 1

    def test_missing_audio_file_raises(self, tmp_path):
        """Test missing audio_file field raises ValueError."""
        json_path = tmp_path / "speakers.json"
        data = {"segments": []}
        json_path.write_text(json.dumps(data))

        with pytest.raises(ValueError, match="Missing required field 'audio_file'"):
            load_diarization_json(json_path)

    def test_missing_segments_raises(self, tmp_path):
        """Test missing segments field raises ValueError."""
        json_path = tmp_path / "speakers.json"
        data = {"audio_file": "/path/to/audio.wav"}
        json_path.write_text(json.dumps(data))

        with pytest.raises(ValueError, match="Missing required field 'segments'"):
            load_diarization_json(json_path)

    def test_additional_fields_preserved(self, tmp_path):
        """Test that additional fields are preserved."""
        json_path = tmp_path / "speakers.json"
        data = {
            "audio_file": "/path/to/audio.wav",
            "segments": [],
            "model": "pyannote",
            "num_speakers": 2,
        }
        json_path.write_text(json.dumps(data))

        result = load_diarization_json(json_path)
        assert result["model"] == "pyannote"
        assert result["num_speakers"] == 2

    def test_unicode_content(self, tmp_path):
        """Test loading JSON with Unicode content."""
        json_path = tmp_path / "speakers.json"
        data = {
            "audio_file": "/cesta/k/příliš_žluťoučký.wav",
            "segments": [
                {"speaker": "MLUVČÍ_00", "start": 0.0, "end": 1.0},
            ],
        }
        json_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

        result = load_diarization_json(json_path)
        assert "žluťoučký" in result["audio_file"]


class TestHuggingFaceToken:
    """Tests for get_hf_token function behavior."""

    def test_hf_token_env_var(self, monkeypatch, huggingface_hub_stub):
        """Test HF_TOKEN environment variable is checked."""
        monkeypatch.setenv("HF_TOKEN", "test_token_123")
        monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)
        monkeypatch.setattr(huggingface_hub_stub, "get_token", lambda: None)

        assert get_hf_token() == "test_token_123"

    def test_huggingface_token_fallback(self, monkeypatch, huggingface_hub_stub):
        """Test HUGGINGFACE_TOKEN fallback."""
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "fallback_token")
        monkeypatch.setattr(huggingface_hub_stub, "get_token", lambda: None)

        assert get_hf_token() == "fallback_token"

    def test_hf_token_takes_precedence(self, monkeypatch, huggingface_hub_stub):
        """Test HF_TOKEN takes precedence over HUGGINGFACE_TOKEN."""
        monkeypatch.setenv("HF_TOKEN", "primary")
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "secondary")
        monkeypatch.setattr(huggingface_hub_stub, "get_token", lambda: "cached")

        assert get_hf_token() == "primary"

    def test_cached_login_fallback(self, monkeypatch, huggingface_hub_stub):
        """Test fallback to cached Hugging Face login when env vars are unset."""

        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)
        monkeypatch.setattr(huggingface_hub_stub, "get_token", lambda: "cached_token")

        assert get_hf_token() == "cached_token"

    def test_missing_token_exits(self, monkeypatch, huggingface_hub_stub):
        """Test missing token exits with a helpful message."""

        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)
        monkeypatch.setattr(huggingface_hub_stub, "get_token", lambda: None)

        with pytest.raises(SystemExit):
            get_hf_token()


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    def test_segment_key_with_zero_duration(self):
        """Test segment key with zero duration."""
        key = segment_key("SPK", 1.0, 1.0)
        assert key == ("SPK", 1.0, 1.0)

    def test_checksum_reproducible(self):
        """Test checksum is reproducible across calls."""
        segments = [
            {"speaker": "A", "start": 0.0, "end": 1.0},
            {"speaker": "B", "start": 1.0, "end": 2.0},
        ]
        checksums = [compute_segments_checksum(segments) for _ in range(100)]
        assert len(set(checksums)) == 1  # All identical

    def test_very_precise_timestamps(self):
        """Test handling of very precise timestamps."""
        key = segment_key("SPK", 0.123456789012345, 1.987654321098765)
        # Should round to 3 decimal places
        assert key == ("SPK", 0.123, 1.988)

    def test_large_timestamp_values(self):
        """Test handling of large timestamp values."""
        key = segment_key("SPK", 99999.9994, 100000.0016)
        # 99999.9994 rounds to 99999.999, 100000.0016 rounds to 100000.002
        assert key == ("SPK", 99999.999, 100000.002)
