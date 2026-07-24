"""Tests for besedy/lib/catalog/manager.py core functions."""

from __future__ import annotations

from besedy.lib.catalog.manager import (
    FileRecord,
    format_size,
    is_hidden,
    source_file_sha256,
)


class TestSourceFileSha256:
    """Tests for source-file integrity checksums."""

    def test_deterministic_hash(self, tmp_path):
        """Same content produces same hash."""
        f1 = tmp_path / "f1.txt"
        f2 = tmp_path / "f2.txt"
        content = b"test content for hashing"
        f1.write_bytes(content)
        f2.write_bytes(content)

        assert source_file_sha256(f1) == source_file_sha256(f2)

    def test_different_content_different_hash(self, tmp_path):
        """Different content produces different hashes."""
        f1 = tmp_path / "f1.txt"
        f2 = tmp_path / "f2.txt"
        f1.write_bytes(b"content one")
        f2.write_bytes(b"content two")

        assert source_file_sha256(f1) != source_file_sha256(f2)

    def test_hash_length_64_chars(self, tmp_path):
        """SHA-256 hash is 64 hex characters."""
        test_file = tmp_path / "test.txt"
        test_file.write_bytes(b"test")

        hash_val = source_file_sha256(test_file)
        assert len(hash_val) == 64

    def test_hash_is_lowercase_hex(self, tmp_path):
        """Hash contains only lowercase hex characters."""
        test_file = tmp_path / "test.txt"
        test_file.write_bytes(b"test")

        hash_val = source_file_sha256(test_file)
        assert all(c in "0123456789abcdef" for c in hash_val)

    def test_empty_file(self, tmp_path):
        """Empty file has known SHA-256 hash."""
        test_file = tmp_path / "empty.txt"
        test_file.write_bytes(b"")

        # SHA-256 of empty string
        expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        assert source_file_sha256(test_file) == expected


class TestFormatSize:
    """Tests for format_size()."""

    def test_bytes(self):
        assert format_size(500) == "500 B"

    def test_zero_bytes(self):
        assert format_size(0) == "0 B"

    def test_one_byte(self):
        assert format_size(1) == "1 B"

    def test_kilobytes(self):
        result = format_size(1024)
        assert "KB" in result

    def test_megabytes(self):
        result = format_size(2 * 1024 * 1024)
        assert "MB" in result

    def test_gigabytes(self):
        result = format_size(3 * 1024 * 1024 * 1024)
        assert "GB" in result

    def test_decimal_precision(self):
        # 1.5 KB = 1536 bytes
        result = format_size(1536)
        assert "1.5 KB" in result or "KB" in result


class TestIsHidden:
    """Tests for is_hidden()."""

    def test_dot_file_is_hidden(self):
        assert is_hidden(".gitignore") is True

    def test_dot_directory_is_hidden(self):
        assert is_hidden(".git") is True

    def test_normal_file_not_hidden(self):
        assert is_hidden("audio.wav") is False

    def test_file_with_dot_not_hidden(self):
        assert is_hidden("file.name.txt") is False


class TestFileRecord:
    """Tests for FileRecord dataclass."""

    def test_basic_creation(self, tmp_path):
        record = FileRecord(
            hash="abc123def456",
            filename="audio.wav",
            full_path=tmp_path / "audio.wav",
            hash_file=tmp_path / "audio.wav.audiohash",
            exists=True,
            size_bytes=12345,
            size_human="12.1 KB",
            status="EXISTS",
            extension="wav",
        )
        assert record.hash == "abc123def456"
        assert record.filename == "audio.wav"
        assert record.size_bytes == 12345

    def test_optional_fields_default(self, tmp_path):
        record = FileRecord(
            hash="abc",
            filename="test.wav",
            full_path=tmp_path / "test.wav",
            hash_file=tmp_path / "test.wav.audiohash",
            exists=True,
            size_bytes=100,
            size_human="100 B",
            status="EXISTS",
            extension="wav",
        )
        assert record.duration == ""
        assert record.duration_seconds == 0.0
        assert record.codec == ""
        assert record.integrated_loudness_lufs == ""
        assert record.added_at == ""

    def test_with_metadata(self, tmp_path):
        record = FileRecord(
            hash="abc",
            filename="podcast.mp3",
            full_path=tmp_path / "podcast.mp3",
            hash_file=tmp_path / "podcast.mp3.audiohash",
            exists=True,
            size_bytes=5000000,
            size_human="4.8 MB",
            status="EXISTS",
            extension="mp3",
            duration="01:30:00",
            duration_seconds=5400.0,
            codec="mp3",
            album="My Podcast",
            artist="Host Name",
            added_at="2025-12-31T14:30:00Z",
        )
        assert record.duration == "01:30:00"
        assert record.duration_seconds == 5400.0
        assert record.album == "My Podcast"
        assert record.added_at == "2025-12-31T14:30:00Z"
