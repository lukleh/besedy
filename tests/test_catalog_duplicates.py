"""Tests for catalog duplicate handling functionality."""

from __future__ import annotations

import csv
from pathlib import Path

from besedy.commands.catalog.file_processing import (
    AddFilesResult,
    write_duplicates_report,
)
from besedy.commands.catalog.ui import METADATA_TAG_COLUMNS, write_duplicates_csv
from besedy.lib.catalog.manager import FileRecord


def make_file_record(
    hash: str,
    full_path: str,
    *,
    duration: str = "",
    album: str = "",
    artist: str = "",
    title: str = "",
) -> FileRecord:
    """Create a FileRecord for testing."""
    return FileRecord(
        hash=hash,
        filename=Path(full_path).name,
        full_path=Path(full_path),
        hash_file=Path(f"{full_path}.audiohash"),
        exists=True,
        size_bytes=1000,
        size_human="1.0 KB",
        status="EXISTS",
        extension=Path(full_path).suffix.lstrip("."),
        duration=duration,
        album=album,
        artist=artist,
        title=title,
    )


class TestWriteDuplicatesCsv:
    """Tests for write_duplicates_csv function."""

    def test_writes_csv_with_correct_columns(self, tmp_path: Path) -> None:
        """Test that CSV has all 15 expected columns."""
        original = make_file_record("abc123" + "0" * 58, "/path/to/original.mp3")
        duplicate = make_file_record(
            "abc123" + "0" * 58,
            "/path/to/duplicate.mp3",
            duration="01:30:00",
            album="Test Album",
            artist="Test Artist",
            title="Test Title",
        )

        duplicates = {"abc123" + "0" * 58: [duplicate]}
        first_by_hash = {"abc123" + "0" * 58: original}

        output_path = tmp_path / "duplicates.csv"
        count = write_duplicates_csv(duplicates, first_by_hash, output_path)

        assert count == 1
        assert output_path.exists()

        with output_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            columns = reader.fieldnames
            assert columns is not None

            # Check all expected columns
            expected_columns = [
                "Hash",
                "Original Path",
                "Duplicate Path",
                "Scan Root",
                "Size (bytes)",
                "Size (human)",
                "Duration",
                "added_at",
                *METADATA_TAG_COLUMNS,
            ]
            assert list(columns) == expected_columns

    def test_writes_duplicate_metadata(self, tmp_path: Path) -> None:
        """Test that duplicate file metadata is written correctly."""
        hash_value = "abc123" + "0" * 58
        original = make_file_record(hash_value, "/path/to/original.mp3")
        duplicate = make_file_record(
            hash_value,
            "/path/to/duplicate.mp3",
            duration="01:30:00",
            album="My Album",
            artist="My Artist",
            title="My Title",
        )

        duplicates = {hash_value: [duplicate]}
        first_by_hash = {hash_value: original}

        output_path = tmp_path / "duplicates.csv"
        write_duplicates_csv(duplicates, first_by_hash, output_path)

        with output_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            row = next(reader)

            assert row["Hash"] == hash_value
            assert row["Original Path"] == "/path/to/original.mp3"
            assert row["Duplicate Path"] == "/path/to/duplicate.mp3"
            assert row["Duration"] == "01:30:00"
            assert row["album"] == "My Album"
            assert row["artist"] == "My Artist"
            assert row["title"] == "My Title"

    def test_returns_zero_for_empty_duplicates(self, tmp_path: Path) -> None:
        """Test that empty duplicates dict returns 0 and doesn't create file."""
        output_path = tmp_path / "duplicates.csv"
        count = write_duplicates_csv({}, {}, output_path)

        assert count == 0
        assert not output_path.exists()

    def test_multiple_duplicates_same_hash(self, tmp_path: Path) -> None:
        """Test handling multiple duplicates with same hash."""
        hash_value = "abc123" + "0" * 58
        original = make_file_record(hash_value, "/path/to/original.mp3")
        dup1 = make_file_record(hash_value, "/path/to/dup1.mp3", title="Dup 1")
        dup2 = make_file_record(hash_value, "/path/to/dup2.mp3", title="Dup 2")

        duplicates = {hash_value: [dup1, dup2]}
        first_by_hash = {hash_value: original}

        output_path = tmp_path / "duplicates.csv"
        count = write_duplicates_csv(duplicates, first_by_hash, output_path)

        assert count == 2

        with output_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            assert len(rows) == 2
            titles = {row["title"] for row in rows}
            assert titles == {"Dup 1", "Dup 2"}


class TestWriteDuplicatesReport:
    """Tests for write_duplicates_report function."""

    def test_writes_report_from_records(self, tmp_path: Path) -> None:
        """Test that write_duplicates_report correctly builds structures."""
        hash_value = "abc123" + "0" * 58
        duplicate = make_file_record(hash_value, "/path/to/duplicate.mp3")

        hash_to_original_path = {hash_value: "/path/to/original.mp3"}
        output_path = tmp_path / "duplicates.csv"

        count = write_duplicates_report(
            duplicate_records=[duplicate],
            new_records=[],
            hash_to_original_path=hash_to_original_path,
            duplicates_csv_path=output_path,
        )

        assert count == 1
        assert output_path.exists()

    def test_returns_zero_for_empty_records(self, tmp_path: Path) -> None:
        """Test that empty records returns 0."""
        output_path = tmp_path / "duplicates.csv"
        count = write_duplicates_report(
            duplicate_records=[],
            new_records=[],
            hash_to_original_path={},
            duplicates_csv_path=output_path,
        )

        assert count == 0
        assert not output_path.exists()

    def test_finds_original_in_new_records(self, tmp_path: Path) -> None:
        """Test that original path is found from new_records for within-batch duplicates."""
        hash_value = "abc123" + "0" * 58
        new_record = make_file_record(hash_value, "/path/to/new.mp3")
        duplicate = make_file_record(hash_value, "/path/to/duplicate.mp3")

        output_path = tmp_path / "duplicates.csv"

        count = write_duplicates_report(
            duplicate_records=[duplicate],
            new_records=[new_record],
            hash_to_original_path={},  # Empty - should find in new_records
            duplicates_csv_path=output_path,
        )

        assert count == 1

        with output_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            row = next(reader)
            assert row["Original Path"] == "/path/to/new.mp3"

    def test_uses_empty_path_when_original_not_found(self, tmp_path: Path) -> None:
        """Test that empty string is used when original path cannot be determined."""
        hash_value = "abc123" + "0" * 58
        duplicate = make_file_record(hash_value, "/path/to/duplicate.mp3")

        output_path = tmp_path / "duplicates.csv"

        count = write_duplicates_report(
            duplicate_records=[duplicate],
            new_records=[],  # No new records
            hash_to_original_path={},  # Empty - original unknown
            duplicates_csv_path=output_path,
        )

        assert count == 1

        with output_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            row = next(reader)
            # Should be empty, not "." (which Path("") produces) or "/unknown"
            assert row["Original Path"] == ""


class TestDuplicatesMergeScenario:
    """Tests for merging existing duplicates with new duplicates."""

    def test_merge_preserves_existing_and_adds_new(self, tmp_path: Path) -> None:
        """Test that merge logic preserves existing duplicates when adding new ones.

        This simulates the workflow in handle_add() where:
        1. Existing duplicates CSV has entries
        2. New duplicates are found
        3. Both are preserved in the final CSV
        """
        from besedy.commands.catalog.ui import DUPLICATES_CSV_COLUMNS
        from besedy.lib.catalog.manager import load_csv

        hash1 = "abc123" + "0" * 58
        hash2 = "def456" + "0" * 58

        duplicates_csv_path = tmp_path / "audio_catalog_duplicates.csv"

        # Step 1: Create existing duplicates CSV with one entry
        existing_dup = make_file_record(hash1, "/path/to/existing_dup.mp3", title="Existing")
        hash_to_original_path_v1 = {hash1: "/path/to/original1.mp3"}
        write_duplicates_report(
            duplicate_records=[existing_dup],
            new_records=[],
            hash_to_original_path=hash_to_original_path_v1,
            duplicates_csv_path=duplicates_csv_path,
        )

        # Verify existing CSV has 1 row
        _, existing_rows = load_csv(duplicates_csv_path, encoding="utf-8")
        assert len(existing_rows) == 1
        assert existing_rows[0]["title"] == "Existing"

        # Step 2: Write new duplicates (this would overwrite if not merged)
        new_dup = make_file_record(hash2, "/path/to/new_dup.mp3", title="New")
        hash_to_original_path_v2 = {hash2: "/path/to/original2.mp3"}
        write_duplicates_report(
            duplicate_records=[new_dup],
            new_records=[],
            hash_to_original_path=hash_to_original_path_v2,
            duplicates_csv_path=duplicates_csv_path,
        )

        # Read new rows
        _, new_rows = load_csv(duplicates_csv_path, encoding="utf-8")

        # Step 3: Merge using canonical columns (simulate handle_add logic)
        combined_rows = existing_rows + new_rows
        columns = list(DUPLICATES_CSV_COLUMNS)
        normalized_rows = [{col: row.get(col, "") for col in columns} for row in combined_rows]
        with duplicates_csv_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
            writer.writeheader()
            writer.writerows(normalized_rows)

        # Step 4: Verify both entries are preserved
        _, final_rows = load_csv(duplicates_csv_path, encoding="utf-8")
        assert len(final_rows) == 2

        titles = {row["title"] for row in final_rows}
        assert titles == {"Existing", "New"}

        # Verify each row has correct original path
        for row in final_rows:
            if row["title"] == "Existing":
                assert row["Duplicate Path"] == "/path/to/existing_dup.mp3"
                assert row["Original Path"] == "/path/to/original1.mp3"
            else:
                assert row["Duplicate Path"] == "/path/to/new_dup.mp3"
                assert row["Original Path"] == "/path/to/original2.mp3"


class TestAddFilesResultDataclass:
    """Tests for AddFilesResult dataclass."""

    def test_creates_with_all_fields(self) -> None:
        """Test that AddFilesResult can be created with all fields."""
        record = make_file_record("abc123" + "0" * 58, "/path/to/file.mp3")
        result = AddFilesResult(
            new_records=[record],
            duplicate_records=[],
            errors=["error1"],
            sidecar_warnings=["warning1"],
        )

        assert len(result.new_records) == 1
        assert len(result.duplicate_records) == 0
        assert result.errors == ["error1"]
        assert result.sidecar_warnings == ["warning1"]
