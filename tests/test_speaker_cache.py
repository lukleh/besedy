"""Tests for besedy/lib/speakers/cache.py.

Tests cover:
- EmbeddingCache initialization
- Cache mode handling (none, file, segment)
- Cache load/save operations
- Segment aggregation
- Cache invalidation
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np

from besedy.lib.speakers.cache import EmbeddingCache


class TestEmbeddingCacheInit:
    """Tests for EmbeddingCache initialization."""

    def test_file_mode_creates_directory(self, tmp_path):
        """Test file mode creates cache directory."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )
        assert cache.mode == "file"
        assert cache.base_dir.exists()
        assert cache.base_dir == (tmp_path / "test_model" / "file").resolve()

    def test_segment_mode_creates_directory(self, tmp_path):
        """Test segment mode creates cache directory."""
        cache = EmbeddingCache(
            mode="segment",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.3,
        )
        assert cache.mode == "segment"
        assert cache.base_dir.exists()

    def test_none_mode_no_directory(self, tmp_path):
        """Test none mode doesn't create directory."""
        cache = EmbeddingCache(
            mode="none",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )
        assert cache.mode == "none"
        assert cache.base_dir is None

    def test_refresh_flag(self, tmp_path):
        """Test refresh flag is stored."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
            refresh=True,
        )
        assert cache.refresh is True


class TestEmbeddingCacheEnabled:
    """Tests for enabled method."""

    def test_enabled_for_file_mode(self, tmp_path):
        """Test enabled returns True for file mode."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )
        assert cache.enabled() is True

    def test_enabled_for_segment_mode(self, tmp_path):
        """Test enabled returns True for segment mode."""
        cache = EmbeddingCache(
            mode="segment",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )
        assert cache.enabled() is True

    def test_disabled_for_none_mode(self, tmp_path):
        """Test enabled returns False for none mode."""
        cache = EmbeddingCache(
            mode="none",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )
        assert cache.enabled() is False


class TestCacheFileHelpers:
    """Tests for cache file helper methods."""

    def test_same_path_matching(self, tmp_path):
        """Test _same_path with matching paths."""
        test_file = tmp_path / "test.wav"
        test_file.touch()

        assert EmbeddingCache._same_path(str(test_file), test_file) is True

    def test_same_path_different_paths(self, tmp_path):
        """Test _same_path with different paths."""
        file1 = tmp_path / "test1.wav"
        file2 = tmp_path / "test2.wav"
        file1.touch()
        file2.touch()

        assert EmbeddingCache._same_path(str(file1), file2) is False

    def test_same_path_none(self):
        """Test _same_path with None stored path."""
        assert EmbeddingCache._same_path(None, Path("/some/path")) is False

    def test_same_float_matching(self):
        """Test _same_float with matching values."""
        assert EmbeddingCache._same_float(1.234, 1.234) is True
        assert EmbeddingCache._same_float(1.234, 1.2341) is True  # Within tolerance

    def test_same_float_different(self):
        """Test _same_float with different values."""
        assert EmbeddingCache._same_float(1.234, 1.240) is False  # Outside tolerance

    def test_same_float_none(self):
        """Test _same_float with None stored value."""
        assert EmbeddingCache._same_float(None, 1.234) is False


class TestCacheLoad:
    """Tests for cache load method."""

    def test_load_disabled_returns_disabled(self, tmp_path):
        """Test load returns disabled status when caching is disabled."""
        cache = EmbeddingCache(
            mode="none",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        result = cache.load(
            file_identifier="test",
            audio_file=Path("/test.wav"),
            audio_stat=MagicMock(st_mtime=1234567890.0, st_size=1024),
            json_stat=MagicMock(st_mtime=1234567890.0),
            segments_checksum="abc123",
        )

        assert result["status"] == "disabled"

    def test_load_missing_cache_file(self, tmp_path):
        """Test load returns miss when cache file doesn't exist."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        result = cache.load(
            file_identifier="nonexistent",
            audio_file=Path("/test.wav"),
            audio_stat=MagicMock(st_mtime=1234567890.0, st_size=1024),
            json_stat=MagicMock(st_mtime=1234567890.0),
            segments_checksum="abc123",
        )

        assert result["status"] == "miss"

    def test_load_refresh_mode_returns_miss(self, tmp_path):
        """Test load returns miss when refresh is True."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
            refresh=True,
        )

        result = cache.load(
            file_identifier="test",
            audio_file=Path("/test.wav"),
            audio_stat=MagicMock(st_mtime=1234567890.0, st_size=1024),
            json_stat=MagicMock(st_mtime=1234567890.0),
            segments_checksum="abc123",
        )

        assert result["status"] == "miss"


class TestCacheSaveFileEmbeddings:
    """Tests for save_file_embeddings method."""

    def test_save_file_embeddings(self, tmp_path):
        """Test saving file embeddings to cache."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        speaker_embeddings = {
            "SPEAKER_00": np.array([0.1, 0.2, 0.3], dtype=np.float32),
            "SPEAKER_01": np.array([0.4, 0.5, 0.6], dtype=np.float32),
        }
        speaker_stats = {
            "SPEAKER_00": {"num_segments": 5, "total_duration": 30.0},
            "SPEAKER_01": {"num_segments": 3, "total_duration": 20.0},
        }

        cache.save_file_embeddings(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_file.stat(),
            json_stat=audio_file.stat(),  # Using same stat for simplicity
            segments_checksum="checksum123",
            speaker_embeddings=speaker_embeddings,
            speaker_stats=speaker_stats,
        )

        # Verify file was created
        cache_file = cache.base_dir / "test_hash" / "embeddings.json"
        assert cache_file.exists()

        # Verify content
        with cache_file.open() as f:
            data = json.load(f)
        assert data["metadata"]["version"] == EmbeddingCache.VERSION
        assert data["metadata"]["mode"] == "file"
        assert "SPEAKER_00" in data["speakers"]
        assert "SPEAKER_01" in data["speakers"]

    def test_save_skipped_for_none_mode(self, tmp_path):
        """Test save is skipped for none mode."""
        cache = EmbeddingCache(
            mode="none",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        # Should not raise, just return silently
        cache.save_file_embeddings(
            file_identifier="test",
            audio_file=Path("/test.wav"),
            audio_stat=MagicMock(),
            json_stat=MagicMock(),
            segments_checksum="abc",
            speaker_embeddings={"SPK": np.array([1.0])},
            speaker_stats={},
        )

    def test_save_skipped_for_empty_embeddings(self, tmp_path):
        """Test save is skipped for empty embeddings."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        cache.save_file_embeddings(
            file_identifier="test",
            audio_file=Path("/test.wav"),
            audio_stat=MagicMock(),
            json_stat=MagicMock(),
            segments_checksum="abc",
            speaker_embeddings={},  # Empty
            speaker_stats={},
        )

        # No cache file should be created
        cache_file = cache.base_dir / "test" / "embeddings.json"
        assert not cache_file.exists()


class TestCacheSaveSegmentEmbeddings:
    """Tests for save_segment_embeddings method."""

    def test_save_segment_embeddings(self, tmp_path):
        """Test saving segment embeddings to cache."""
        cache = EmbeddingCache(
            mode="segment",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        segment_records = [
            {
                "speaker": "SPEAKER_00",
                "start": 0.0,
                "end": 1.5,
                "duration": 1.5,
                "vector": np.array([0.1, 0.2, 0.3], dtype=np.float32),
            },
            {
                "speaker": "SPEAKER_01",
                "start": 1.5,
                "end": 3.0,
                "duration": 1.5,
                "vector": np.array([0.4, 0.5, 0.6], dtype=np.float32),
            },
        ]

        cache.save_segment_embeddings(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_file.stat(),
            json_stat=audio_file.stat(),
            segments_checksum="checksum123",
            segment_records=segment_records,
        )

        # Verify file was created
        cache_file = cache.base_dir / "test_hash" / "embeddings.json"
        assert cache_file.exists()

        # Verify content
        with cache_file.open() as f:
            data = json.load(f)
        assert data["metadata"]["mode"] == "segment"
        assert len(data["segments"]) == 2


class TestAggregateSegments:
    """Tests for aggregate_segments static method."""

    def test_single_speaker(self):
        """Test aggregation for single speaker."""
        segment_records = [
            {
                "speaker": "SPEAKER_00",
                "start": 0.0,
                "end": 1.0,
                "duration": 1.0,
                "vector": np.array([1.0, 0.0, 0.0], dtype=np.float32),
            },
            {
                "speaker": "SPEAKER_00",
                "start": 1.0,
                "end": 2.0,
                "duration": 1.0,
                "vector": np.array([0.0, 1.0, 0.0], dtype=np.float32),
            },
        ]

        aggregated, stats = EmbeddingCache.aggregate_segments(segment_records)

        assert "SPEAKER_00" in aggregated
        assert stats["SPEAKER_00"]["num_segments"] == 2
        assert stats["SPEAKER_00"]["total_duration"] == 2.0
        # Result should be normalized
        norm = np.linalg.norm(aggregated["SPEAKER_00"])
        assert np.isclose(norm, 1.0, atol=1e-6)

    def test_multiple_speakers(self):
        """Test aggregation for multiple speakers."""
        segment_records = [
            {
                "speaker": "SPEAKER_00",
                "start": 0.0,
                "end": 1.0,
                "duration": 1.0,
                "vector": np.array([1.0, 0.0], dtype=np.float32),
            },
            {
                "speaker": "SPEAKER_01",
                "start": 1.0,
                "end": 2.0,
                "duration": 1.0,
                "vector": np.array([0.0, 1.0], dtype=np.float32),
            },
        ]

        aggregated, stats = EmbeddingCache.aggregate_segments(segment_records)

        assert len(aggregated) == 2
        assert "SPEAKER_00" in aggregated
        assert "SPEAKER_01" in aggregated

    def test_duration_weighting(self):
        """Test that duration weighting is applied."""
        # One short segment, one long segment for same speaker
        segment_records = [
            {
                "speaker": "SPK",
                "start": 0.0,
                "end": 1.0,
                "duration": 1.0,
                "vector": np.array([1.0, 0.0], dtype=np.float32),
            },
            {
                "speaker": "SPK",
                "start": 1.0,
                "end": 10.0,
                "duration": 9.0,
                "vector": np.array([0.0, 1.0], dtype=np.float32),
            },
        ]

        aggregated, stats = EmbeddingCache.aggregate_segments(segment_records)

        # Result should be weighted toward the longer segment
        # The second vector has 9x the weight
        result = aggregated["SPK"]
        # Second component should be dominant
        assert result[1] > result[0]

    def test_empty_records(self):
        """Test aggregation with empty records."""
        aggregated, stats = EmbeddingCache.aggregate_segments([])
        assert aggregated == {}
        assert stats == {}

    def test_computed_duration(self):
        """Test duration is computed from start/end if not provided."""
        segment_records = [
            {
                "speaker": "SPK",
                "start": 0.0,
                "end": 2.5,
                # No duration field
                "vector": np.array([1.0, 0.0], dtype=np.float32),
            },
        ]

        aggregated, stats = EmbeddingCache.aggregate_segments(segment_records)

        assert stats["SPK"]["total_duration"] == 2.5


class TestCacheRoundTrip:
    """Tests for cache save and load round trip."""

    def test_file_mode_round_trip(self, tmp_path):
        """Test saving and loading file embeddings."""
        cache = EmbeddingCache(
            mode="file",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        audio_file = tmp_path / "test.wav"
        audio_file.write_bytes(b"fake audio content")
        audio_stat = audio_file.stat()

        json_file = tmp_path / "speakers.json"
        json_file.write_text("{}")
        json_stat = json_file.stat()

        # Save embeddings
        speaker_embeddings = {
            "SPEAKER_00": np.array([0.1, 0.2, 0.3], dtype=np.float32),
        }
        speaker_stats = {
            "SPEAKER_00": {"num_segments": 2, "total_duration": 10.0},
        }

        cache.save_file_embeddings(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_stat,
            json_stat=json_stat,
            segments_checksum="checksum123",
            speaker_embeddings=speaker_embeddings,
            speaker_stats=speaker_stats,
        )

        # Load embeddings
        result = cache.load(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_stat,
            json_stat=json_stat,
            segments_checksum="checksum123",
        )

        assert result["status"] == "hit"
        assert "SPEAKER_00" in result["speaker_embeddings"]
        np.testing.assert_array_almost_equal(
            result["speaker_embeddings"]["SPEAKER_00"],
            speaker_embeddings["SPEAKER_00"],
        )

    def test_segment_mode_round_trip(self, tmp_path):
        """Test saving and loading segment embeddings."""
        cache = EmbeddingCache(
            mode="segment",
            cache_dir=tmp_path,
            model_name="test_model",
            min_duration=0.5,
        )

        audio_file = tmp_path / "test.wav"
        audio_file.write_bytes(b"fake audio content")
        audio_stat = audio_file.stat()

        json_file = tmp_path / "speakers.json"
        json_file.write_text("{}")
        json_stat = json_file.stat()

        # Save segments
        segment_records = [
            {
                "speaker": "SPEAKER_00",
                "start": 0.0,
                "end": 1.5,
                "duration": 1.5,
                "vector": np.array([0.1, 0.2, 0.3], dtype=np.float32),
            },
        ]

        cache.save_segment_embeddings(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_stat,
            json_stat=json_stat,
            segments_checksum="checksum123",
            segment_records=segment_records,
        )

        # Load segments
        result = cache.load(
            file_identifier="test_hash",
            audio_file=audio_file,
            audio_stat=audio_stat,
            json_stat=json_stat,
            segments_checksum="checksum123",
        )

        assert result["status"] == "hit"
        assert len(result["segment_map"]) == 1
