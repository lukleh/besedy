"""Tests for the find-duplicates command."""

from __future__ import annotations

from besedy.commands.catalog.duplicates import (
    derive_common_root,
    find_hash_sidecar_files,
    format_size,
    get_file_size,
    load_catalog_hashes,
    parse_hash_sidecar_file,
)


class TestLoadCatalogHashes:
    """Tests for catalog loading."""

    def test_loads_valid_csv(self, tmp_path):
        """Load a valid CSV with Hash and Full Path columns."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text("Hash,Filename,Full Path\nabc123,f1.wav,/path/f1.wav\n")
        result = load_catalog_hashes(csv_path)
        assert result == {"abc123": "/path/f1.wav"}

    def test_handles_empty_csv(self, tmp_path):
        """Empty CSV (header only) returns empty dict."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text("Hash,Filename,Full Path\n")
        result = load_catalog_hashes(csv_path)
        assert result == {}

    def test_handles_multiple_rows(self, tmp_path):
        """Multiple rows are all loaded."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            "Hash,Full Path\nhash1,/path/file1.wav\nhash2,/path/file2.wav\nhash3,/path/file3.wav\n"
        )
        result = load_catalog_hashes(csv_path)
        assert len(result) == 3
        assert result["hash1"] == "/path/file1.wav"
        assert result["hash2"] == "/path/file2.wav"
        assert result["hash3"] == "/path/file3.wav"

    def test_skips_rows_with_empty_hash(self, tmp_path):
        """Rows with empty Hash are skipped."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            "Hash,Full Path\nhash1,/path/file1.wav\n,/path/no_hash.wav\nhash2,/path/file2.wav\n"
        )
        result = load_catalog_hashes(csv_path)
        assert len(result) == 2
        assert "hash1" in result
        assert "hash2" in result


class TestParseHashSidecarFile:
    """Tests for .audiohash file parsing."""

    def test_parses_standard_format_two_spaces(self, tmp_path):
        """Standard format with two-space separator."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        valid_hash = "a" * 64
        sidecar_file.write_text(f"{valid_hash}  file.wav")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is not None
        assert result[0] == valid_hash

    def test_parses_single_space_fallback(self, tmp_path):
        """Falls back to single-space separator."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        valid_hash = "b" * 64
        sidecar_file.write_text(f"{valid_hash} file.wav")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is not None
        assert result[0] == valid_hash

    def test_rejects_invalid_hash_too_short(self, tmp_path):
        """Hash shorter than 64 characters is rejected."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        sidecar_file.write_text("tooshort  file.wav")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is None

    def test_rejects_invalid_hash_non_hex(self, tmp_path):
        """Hash with non-hex characters is rejected."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        invalid_hash = "g" * 64  # 'g' is not a hex character
        sidecar_file.write_text(f"{invalid_hash}  file.wav")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is None

    def test_rejects_empty_file(self, tmp_path):
        """Empty file returns None."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        sidecar_file.write_text("")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is None

    def test_hash_is_lowercased(self, tmp_path):
        """Hash is lowercased for consistency."""
        sidecar_file = tmp_path / "file.wav.audiohash"
        mixed_case_hash = "AbCdEf" + "1" * 58
        sidecar_file.write_text(f"{mixed_case_hash}  file.wav")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is not None
        assert result[0] == mixed_case_hash.lower()

    def test_returns_correct_media_path(self, tmp_path):
        """Media path is the .audiohash file path without extension."""
        sidecar_file = tmp_path / "myaudio.mp3.audiohash"
        valid_hash = "c" * 64
        sidecar_file.write_text(f"{valid_hash}  myaudio.mp3")
        result = parse_hash_sidecar_file(sidecar_file)
        assert result is not None
        assert result[1] == tmp_path / "myaudio.mp3"


class TestFindHashSidecarFiles:
    """Tests for .audiohash file discovery."""

    def test_finds_audiohash_files_in_root(self, tmp_path):
        """Finds .audiohash files in the root directory."""
        (tmp_path / "file1.wav.audiohash").write_text("a" * 64 + "  file1.wav")
        (tmp_path / "file2.wav.audiohash").write_text("b" * 64 + "  file2.wav")
        result = find_hash_sidecar_files(tmp_path)
        assert len(result) == 2

    def test_finds_audiohash_files_recursively(self, tmp_path):
        """Finds .audiohash files in subdirectories."""
        (tmp_path / "file1.wav.audiohash").write_text("a" * 64 + "  file1.wav")
        subdir = tmp_path / "subdir"
        subdir.mkdir()
        (subdir / "file2.wav.audiohash").write_text("b" * 64 + "  file2.wav")
        result = find_hash_sidecar_files(tmp_path)
        assert len(result) == 2

    def test_skips_macos_metadata_files(self, tmp_path):
        """Skips macOS metadata files (._*)."""
        (tmp_path / "._file.wav.audiohash").write_text("hidden")
        (tmp_path / "file.wav.audiohash").write_text("a" * 64 + "  file.wav")
        result = find_hash_sidecar_files(tmp_path)
        assert len(result) == 1
        assert result[0].name == "file.wav.audiohash"

    def test_skips_synology_metadata_dirs(self, tmp_path):
        """Skips Synology @eaDir metadata directories."""
        eadir = tmp_path / "@eaDir"
        eadir.mkdir()
        (eadir / "file.wav.audiohash").write_text("a" * 64 + "  file.wav")
        (tmp_path / "file.wav.audiohash").write_text("b" * 64 + "  file.wav")
        result = find_hash_sidecar_files(tmp_path)
        assert len(result) == 1
        assert "@eaDir" not in str(result[0])

    def test_returns_empty_list_for_empty_dir(self, tmp_path):
        """Empty directory returns empty list."""
        result = find_hash_sidecar_files(tmp_path)
        assert result == []


class TestFormatSize:
    """Tests for size formatting."""

    def test_bytes(self):
        """Small sizes shown in bytes (integer, no decimal)."""
        assert format_size(500) == "500 B"
        assert format_size(0) == "0 B"
        assert format_size(1023) == "1023 B"

    def test_kilobytes(self):
        """Sizes around 1KB."""
        assert "KB" in format_size(1024)
        assert "KB" in format_size(500 * 1024)

    def test_megabytes(self):
        """Sizes around 1MB."""
        assert "MB" in format_size(1024 * 1024)
        assert "MB" in format_size(5 * 1024 * 1024)

    def test_gigabytes(self):
        """Sizes around 1GB."""
        assert "GB" in format_size(1024 * 1024 * 1024)

    def test_terabytes(self):
        """Sizes around 1TB."""
        assert "TB" in format_size(1024 * 1024 * 1024 * 1024)


class TestDeriveCommonRoot:
    """Tests for common root derivation."""

    def test_finds_common_root_same_dir(self, tmp_path):
        """Files in same directory (with real paths)."""
        # Create real directories for the test
        audio_dir = tmp_path / "data" / "audio"
        audio_dir.mkdir(parents=True)
        (audio_dir / "file1.wav").touch()
        (audio_dir / "file2.wav").touch()
        paths = [str(audio_dir / "file1.wav"), str(audio_dir / "file2.wav")]
        result = derive_common_root(paths)
        assert result == audio_dir

    def test_finds_common_root_different_subdirs(self, tmp_path):
        """Files in different subdirectories (with real paths)."""
        # Create real directories for the test
        audio_dir = tmp_path / "data" / "audio"
        (audio_dir / "2024").mkdir(parents=True)
        (audio_dir / "2023").mkdir(parents=True)
        (audio_dir / "2024" / "file1.wav").touch()
        (audio_dir / "2023" / "file2.wav").touch()
        paths = [
            str(audio_dir / "2024" / "file1.wav"),
            str(audio_dir / "2023" / "file2.wav"),
        ]
        result = derive_common_root(paths)
        assert result == audio_dir

    def test_empty_list_returns_none(self):
        """Empty list returns None."""
        assert derive_common_root([]) is None

    def test_single_path_nonexistent_returns_none(self):
        """Single non-existent path returns None (directory check fails)."""
        paths = ["/nonexistent/path/file.wav"]
        result = derive_common_root(paths)
        # commonpath returns the file path, is_dir() returns False for non-existent
        assert result is None

    def test_single_path_existing_file(self, tmp_path):
        """Single file path returns parent directory (file detected, parent used)."""
        audio_dir = tmp_path / "audio"
        audio_dir.mkdir()
        (audio_dir / "file.wav").touch()
        paths = [str(audio_dir / "file.wav")]
        result = derive_common_root(paths)
        # commonpath of single file is the file itself, is_file() triggers parent lookup
        assert result == audio_dir


class TestGetFileSize:
    """Tests for file size retrieval."""

    def test_returns_size_for_existing_file(self, tmp_path):
        """Returns correct size for existing file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("hello")  # 5 bytes
        assert get_file_size(test_file) == 5

    def test_returns_zero_for_nonexistent_file(self, tmp_path):
        """Returns 0 for non-existent file."""
        nonexistent = tmp_path / "nonexistent.txt"
        assert get_file_size(nonexistent) == 0
