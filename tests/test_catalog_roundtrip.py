"""Tests for catalog CSV roundtrip operations.

Tests CSV reading, writing, and merging without requiring external tools.
"""

from __future__ import annotations

import csv

import pytest

from besedy.lib.catalog.manager import (
    AUDIO_HASH_ALGORITHM,
    FileRecord,
    catalog_fieldnames,
    collect_hashes,
    extend_with_quality_columns,
    file_mtime_to_iso8601,
    file_record_to_row,
    format_size,
    get_iso8601_timestamp,
    load_csv,
    merge_catalogs,
    resolve_hash_column,
    write_catalog_csv,
    write_merged_csv,
)


class TestFormatSize:
    """Tests for format_size() utility."""

    def test_bytes(self):
        """Small values show bytes."""
        assert format_size(0) == "0 B"
        assert format_size(500) == "500 B"
        assert format_size(1023) == "1023 B"

    def test_kilobytes(self):
        """KB range shows one decimal."""
        assert format_size(1024) == "1.0 KB"
        assert format_size(1536) == "1.5 KB"
        assert format_size(10240) == "10.0 KB"

    def test_megabytes(self):
        """MB range shows one decimal."""
        assert format_size(1048576) == "1.0 MB"
        assert format_size(5242880) == "5.0 MB"

    def test_gigabytes(self):
        """GB range shows one decimal."""
        assert format_size(1073741824) == "1.0 GB"


class TestCatalogFieldnames:
    """Tests for catalog_fieldnames()."""

    def test_returns_list(self):
        """Returns a list of strings."""
        fields = catalog_fieldnames()
        assert isinstance(fields, list)
        assert all(isinstance(f, str) for f in fields)

    def test_has_required_columns(self):
        """Contains essential columns."""
        fields = catalog_fieldnames()
        assert "Hash" in fields
        assert "Hash Algorithm" in fields
        assert "Filename" in fields
        assert "Full Path" in fields
        assert "Status" in fields
        assert "Duration" in fields
        assert "added_at" in fields

    def test_added_at_position(self):
        """added_at column is after Duration and before metadata columns."""
        fields = catalog_fieldnames()
        duration_idx = fields.index("Duration")
        added_at_idx = fields.index("added_at")
        album_idx = fields.index("album")
        assert duration_idx < added_at_idx < album_idx

    def test_excludes_audio_quality_columns_by_default(self):
        """Base catalog excludes audio quality columns."""
        fields = catalog_fieldnames()
        assert "sample_rate" not in fields
        assert "integrated_loudness_lufs" not in fields
        assert "true_peak_db" not in fields

    def test_can_include_audio_quality_columns(self):
        """Audio quality columns can be included when requested."""
        fields = catalog_fieldnames(include_quality=True)
        assert "sample_rate" in fields
        assert "integrated_loudness_lufs" in fields
        assert "true_peak_db" in fields


class TestFileRecordToRow:
    """Tests for file_record_to_row()."""

    @pytest.fixture
    def sample_record(self, tmp_path):
        """Create a sample FileRecord."""
        return FileRecord(
            hash="abc123def456",
            filename="test.wav",
            full_path=tmp_path / "test.wav",
            hash_file=tmp_path / "test.wav.audiohash",
            exists=True,
            size_bytes=1024,
            size_human="1.0 KB",
            status="EXISTS",
            extension="wav",
            duration="01:30",
            sample_rate="16000",
            channels="1",
            added_at="2025-12-31T14:30:00Z",
        )

    def test_converts_to_dict(self, sample_record):
        """Converts FileRecord to dict with string values."""
        columns = ["Hash", "Filename", "Status"]
        row = file_record_to_row(sample_record, columns)

        assert isinstance(row, dict)
        assert row["Hash"] == "abc123def456"
        assert row["Filename"] == "test.wav"
        assert row["Status"] == "EXISTS"

    def test_persists_hash_algorithm(self, sample_record):
        row = file_record_to_row(sample_record, ["Hash", "Hash Algorithm"])

        assert row["Hash Algorithm"] == AUDIO_HASH_ALGORITHM

    def test_only_includes_requested_columns(self, sample_record):
        """Only includes columns that were requested."""
        columns = ["Hash", "Status"]
        row = file_record_to_row(sample_record, columns)

        assert set(row.keys()) == {"Hash", "Status"}

    def test_missing_column_returns_empty(self, sample_record):
        """Missing/unknown columns return empty string."""
        columns = ["Hash", "nonexistent_column"]
        row = file_record_to_row(sample_record, columns)

        assert row["nonexistent_column"] == ""


class TestWriteCatalogCsv:
    """Tests for write_catalog_csv()."""

    def test_creates_csv_file(self, tmp_path):
        """Creates a CSV file at the specified path."""
        csv_path = tmp_path / "catalog.csv"
        record = FileRecord(
            hash="abc123",
            filename="audio.wav",
            full_path=tmp_path / "audio.wav",
            hash_file=tmp_path / "audio.wav.audiohash",
            exists=True,
            size_bytes=1024,
            size_human="1.0 KB",
            status="EXISTS",
            extension="wav",
        )

        write_catalog_csv([record], csv_path)

        assert csv_path.exists()

    def test_csv_has_header(self, tmp_path):
        """CSV file has header row."""
        csv_path = tmp_path / "catalog.csv"
        write_catalog_csv([], csv_path)

        with csv_path.open() as f:
            reader = csv.DictReader(f)
            assert "Hash" in reader.fieldnames
            assert "Filename" in reader.fieldnames

    def test_csv_can_include_quality_columns(self, tmp_path):
        """CSV can include audio quality columns when requested."""
        csv_path = tmp_path / "catalog.csv"
        write_catalog_csv([], csv_path, include_quality=True)

        with csv_path.open() as f:
            reader = csv.DictReader(f)
            assert "sample_rate" in reader.fieldnames

    def test_csv_contains_record_data(self, tmp_path):
        """CSV contains the record data."""
        csv_path = tmp_path / "catalog.csv"
        record = FileRecord(
            hash="test_hash_123",
            filename="test_audio.mp3",
            full_path=tmp_path / "test_audio.mp3",
            hash_file=tmp_path / "test_audio.mp3.audiohash",
            exists=True,
            size_bytes=2048,
            size_human="2.0 KB",
            status="EXISTS",
            extension="mp3",
        )

        write_catalog_csv([record], csv_path)

        with csv_path.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 1
        assert rows[0]["Hash"] == "test_hash_123"
        assert rows[0]["Filename"] == "test_audio.mp3"

    def test_creates_parent_directories(self, tmp_path):
        """Creates parent directories if needed."""
        csv_path = tmp_path / "nested" / "dir" / "catalog.csv"
        write_catalog_csv([], csv_path)

        assert csv_path.exists()


class TestLoadCsv:
    """Tests for load_csv()."""

    def test_loads_csv_file(self, tmp_path):
        """Loads CSV and returns headers and rows."""
        csv_path = tmp_path / "test.csv"
        csv_path.write_text("col1,col2\nval1,val2\n", encoding="utf-8")

        fieldnames, rows = load_csv(csv_path, encoding="utf-8")

        assert fieldnames == ["col1", "col2"]
        assert len(rows) == 1
        assert rows[0]["col1"] == "val1"
        assert rows[0]["col2"] == "val2"

    def test_empty_csv_raises(self, tmp_path):
        """Empty CSV raises ValueError."""
        csv_path = tmp_path / "empty.csv"
        csv_path.write_text("", encoding="utf-8")

        with pytest.raises(ValueError, match="missing a header"):
            load_csv(csv_path, encoding="utf-8")

    def test_handles_unicode(self, tmp_path):
        """Handles Unicode content correctly."""
        csv_path = tmp_path / "unicode.csv"
        csv_path.write_text("name,value\nčeský,текст\n", encoding="utf-8")

        fieldnames, rows = load_csv(csv_path, encoding="utf-8")

        assert rows[0]["name"] == "český"
        assert rows[0]["value"] == "текст"


class TestResolveHashColumn:
    """Tests for resolve_hash_column()."""

    def test_finds_hash_column(self, tmp_path):
        """Finds 'hash' column."""
        columns = ["name", "hash", "size"]
        path = tmp_path / "test.csv"

        result = resolve_hash_column(columns, path, preferred=None)
        assert result == "hash"

    def test_rejects_sha256_column(self, tmp_path):
        """Rejects 'sha256' column - only 'Hash' is accepted now."""
        columns = ["name", "sha256", "size"]
        path = tmp_path / "test.csv"

        with pytest.raises(ValueError, match="missing required hash column"):
            resolve_hash_column(columns, path, preferred=None)

    def test_preferred_column_takes_priority(self, tmp_path):
        """Preferred column takes priority."""
        columns = ["name", "hash", "Hash", "custom_hash"]
        path = tmp_path / "test.csv"

        result = resolve_hash_column(columns, path, preferred="custom_hash")
        assert result == "custom_hash"

    def test_case_insensitive_lookup(self, tmp_path):
        """Case-insensitive column lookup."""
        columns = ["name", "HASH", "size"]
        path = tmp_path / "test.csv"

        result = resolve_hash_column(columns, path, preferred=None)
        assert result == "HASH"

    def test_raises_when_not_found(self, tmp_path):
        """Raises ValueError when hash column not found."""
        columns = ["name", "size", "status"]
        path = tmp_path / "test.csv"

        with pytest.raises(ValueError, match="missing required hash column"):
            resolve_hash_column(columns, path, preferred=None)


class TestCollectHashes:
    """Tests for collect_hashes()."""

    def test_collects_hashes(self):
        """Collects hash values from rows."""
        rows = [
            {"hash": "abc123"},
            {"hash": "def456"},
            {"hash": "ghi789"},
        ]

        result = collect_hashes(rows, hash_column="hash")

        assert result == {"abc123", "def456", "ghi789"}

    def test_skips_empty_values(self):
        """Skips empty and whitespace-only values."""
        rows = [
            {"hash": "abc123"},
            {"hash": ""},
            {"hash": "   "},
            {"hash": "def456"},
        ]

        result = collect_hashes(rows, hash_column="hash")

        assert result == {"abc123", "def456"}

    def test_handles_missing_column(self):
        """Handles missing column gracefully."""
        rows = [
            {"other": "value"},
        ]

        result = collect_hashes(rows, hash_column="hash")

        assert result == set()


class TestMergeCatalogs:
    """Tests for merge_catalogs()."""

    def test_merges_new_rows(self):
        """Adds new rows from source to target."""
        target = [{"Hash": "abc123", "Filename": "file1.wav"}]
        source = [{"Hash": "def456", "Filename": "file2.wav"}]
        columns = ["Hash", "Filename"]

        merged, appended = merge_catalogs(
            source,
            target,
            columns=columns,
            source_hash_column="Hash",
            target_hash_column="Hash",
        )

        assert len(merged) == 2
        assert len(appended) == 1
        assert appended[0]["Hash"] == "def456"

    def test_skips_duplicates(self):
        """Skips rows with hashes already in target."""
        target = [{"Hash": "abc123", "Filename": "file1.wav"}]
        source = [{"Hash": "abc123", "Filename": "file1_copy.wav"}]
        columns = ["Hash", "Filename"]

        merged, appended = merge_catalogs(
            source,
            target,
            columns=columns,
            source_hash_column="Hash",
            target_hash_column="Hash",
        )

        assert len(merged) == 1
        assert len(appended) == 0

    def test_skips_empty_hashes(self):
        """Skips rows with empty hash values."""
        target = [{"Hash": "abc123", "Filename": "file1.wav"}]
        source = [{"Hash": "", "Filename": "invalid.wav"}]
        columns = ["Hash", "Filename"]

        merged, appended = merge_catalogs(
            source,
            target,
            columns=columns,
            source_hash_column="Hash",
            target_hash_column="Hash",
        )

        assert len(merged) == 1
        assert len(appended) == 0


class TestWriteMergedCsv:
    """Tests for write_merged_csv()."""

    def test_writes_csv(self, tmp_path):
        """Writes rows to CSV file."""
        csv_path = tmp_path / "merged.csv"
        rows = [
            {"Hash": "abc123", "Filename": "file1.wav"},
            {"Hash": "def456", "Filename": "file2.wav"},
        ]
        columns = ["Hash", "Filename"]

        write_merged_csv(csv_path, rows, columns=columns, encoding="utf-8")

        assert csv_path.exists()
        fieldnames, loaded_rows = load_csv(csv_path, encoding="utf-8")
        assert len(loaded_rows) == 2
        assert loaded_rows[0]["Hash"] == "abc123"

    def test_creates_parent_dirs(self, tmp_path):
        """Creates parent directories if needed."""
        csv_path = tmp_path / "nested" / "merged.csv"
        rows = [{"col": "val"}]

        write_merged_csv(csv_path, rows, columns=["col"], encoding="utf-8")

        assert csv_path.exists()


class TestExtendWithQualityColumns:
    """Tests for extend_with_quality_columns()."""

    def test_adds_missing_columns(self):
        """Adds missing audio quality columns."""
        columns = ["Hash", "Filename"]

        result = extend_with_quality_columns(columns)

        assert "sample_rate" in result
        assert "integrated_loudness_lufs" in result
        assert "true_peak_db" in result

    def test_preserves_existing_columns(self):
        """Preserves existing columns in order."""
        columns = ["Hash", "Filename", "sample_rate"]

        result = extend_with_quality_columns(columns)

        # Original columns should be at the start
        assert result[0] == "Hash"
        assert result[1] == "Filename"
        assert result[2] == "sample_rate"

    def test_no_duplicates(self):
        """Does not duplicate existing quality columns."""
        columns = ["Hash", "sample_rate", "channels"]

        result = extend_with_quality_columns(columns)

        # sample_rate and channels should appear only once
        assert result.count("sample_rate") == 1
        assert result.count("channels") == 1


class TestCsvRoundtrip:
    """End-to-end roundtrip tests for CSV operations."""

    def test_write_then_load(self, tmp_path):
        """Write and load produces identical data."""
        csv_path = tmp_path / "roundtrip.csv"
        record = FileRecord(
            hash="roundtrip_hash_123",
            filename="roundtrip.wav",
            full_path=tmp_path / "roundtrip.wav",
            hash_file=tmp_path / "roundtrip.wav.audiohash",
            exists=True,
            size_bytes=4096,
            size_human="4.0 KB",
            status="EXISTS",
            extension="wav",
            duration="02:30",
            sample_rate="44100",
            channels="2",
        )

        write_catalog_csv([record], csv_path, include_quality=True)
        fieldnames, rows = load_csv(csv_path, encoding="utf-8")

        assert len(rows) == 1
        assert rows[0]["Hash"] == "roundtrip_hash_123"
        assert rows[0]["Filename"] == "roundtrip.wav"
        assert rows[0]["Duration"] == "02:30"
        assert rows[0]["sample_rate"] == "44100"
        assert rows[0]["channels"] == "2"

    def test_multiple_records_roundtrip(self, tmp_path):
        """Multiple records survive roundtrip."""
        csv_path = tmp_path / "multi.csv"
        records = [
            FileRecord(
                hash=f"hash_{i}",
                filename=f"file_{i}.wav",
                full_path=tmp_path / f"file_{i}.wav",
                hash_file=tmp_path / f"file_{i}.wav.audiohash",
                exists=True,
                size_bytes=1000 * i,
                size_human=f"{i}.0 KB",
                status="EXISTS",
                extension="wav",
            )
            for i in range(1, 4)
        ]

        write_catalog_csv(records, csv_path)
        fieldnames, rows = load_csv(csv_path, encoding="utf-8")

        assert len(rows) == 3
        assert rows[0]["Hash"] == "hash_1"
        assert rows[1]["Hash"] == "hash_2"
        assert rows[2]["Hash"] == "hash_3"

    def test_unicode_roundtrip(self, tmp_path):
        """Unicode filenames survive roundtrip."""
        csv_path = tmp_path / "unicode.csv"
        record = FileRecord(
            hash="unicode_hash",
            filename="čeština_nahrávka.wav",
            full_path=tmp_path / "čeština_nahrávka.wav",
            hash_file=tmp_path / "čeština_nahrávka.wav.audiohash",
            exists=True,
            size_bytes=1024,
            size_human="1.0 KB",
            status="EXISTS",
            extension="wav",
            title="Český titulek",
            artist="Hudebník",
        )

        write_catalog_csv([record], csv_path)
        fieldnames, rows = load_csv(csv_path, encoding="utf-8")

        assert rows[0]["Filename"] == "čeština_nahrávka.wav"
        assert rows[0]["title"] == "Český titulek"
        assert rows[0]["artist"] == "Hudebník"


class TestTimestampHelpers:
    """Tests for ISO 8601 timestamp helper functions."""

    def test_get_iso8601_timestamp_format(self):
        """Returns properly formatted ISO 8601 timestamp."""
        from datetime import datetime

        ts = get_iso8601_timestamp()
        assert ts.endswith("Z")
        assert "T" in ts
        # Should be 20 characters: YYYY-MM-DDTHH:MM:SSZ
        assert len(ts) == 20
        # Should parse without error
        datetime.fromisoformat(ts.replace("Z", "+00:00"))

    def test_get_iso8601_timestamp_is_utc(self):
        """Timestamp is in UTC timezone."""
        from datetime import datetime, timezone

        ts = get_iso8601_timestamp()
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        assert parsed.tzinfo == timezone.utc

    def test_file_mtime_to_iso8601_existing_file(self, tmp_path):
        """Returns mtime for existing file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("content")

        ts = file_mtime_to_iso8601(test_file)
        assert ts.endswith("Z")
        assert "T" in ts
        assert len(ts) == 20

    def test_file_mtime_to_iso8601_missing_file(self, tmp_path):
        """Returns empty string for missing file."""
        ts = file_mtime_to_iso8601(tmp_path / "missing.txt")
        assert ts == ""

    def test_file_mtime_to_iso8601_directory(self, tmp_path):
        """Returns mtime for directory."""
        ts = file_mtime_to_iso8601(tmp_path)
        assert ts.endswith("Z")
        assert "T" in ts
