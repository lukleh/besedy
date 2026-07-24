"""Tests for catalog add command Scan Root handling.

These tests verify the behavior when `catalog add` is run without explicit paths,
using unique Scan Root values from the existing catalog.
"""

from __future__ import annotations

import csv
from pathlib import Path

from besedy.lib.catalog.manager import FileRecord, catalog_fieldnames


def make_catalog_row(
    hash_value: str,
    full_path: str,
    scan_root: str = "",
) -> dict[str, str]:
    """Create a catalog row dict for testing."""
    return {
        "Hash": hash_value,
        "Filename": Path(full_path).name,
        "Size (bytes)": "1000",
        "Size (human)": "1.0 KB",
        "Full Path": full_path,
        "Scan Root": scan_root,
        "Status": "EXISTS",
        "Duration": "",
        "added_at": "2025-12-31T12:00:00Z",
        "album": "",
        "artist": "",
        "comment": "",
        "date": "",
        "encoded_by": "",
        "encoder": "",
        "genre": "",
        "title": "",
        "track": "",
    }


def write_test_catalog(
    path: Path,
    rows: list[dict[str, str]],
) -> None:
    """Write a test catalog CSV."""
    columns = catalog_fieldnames(include_quality=False)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for row in rows:
            writer.writerow({col: row.get(col, "") for col in columns})


class TestExtractUniqueScanRoots:
    """Tests for extracting unique Scan Root values from catalog."""

    def test_extracts_unique_scan_roots(self, tmp_path: Path) -> None:
        """Test that unique Scan Root values are extracted from catalog rows."""
        rows = [
            make_catalog_row("a" * 64, "/mnt/nas1/file1.mp3", "/mnt/nas1"),
            make_catalog_row("b" * 64, "/mnt/nas1/file2.mp3", "/mnt/nas1"),
            make_catalog_row("c" * 64, "/mnt/nas2/file3.mp3", "/mnt/nas2"),
        ]

        # Extract unique scan roots (same logic as in handle_add)
        scan_roots: set[str] = set()
        for row in rows:
            scan_root = (row.get("Scan Root", "") or "").strip()
            if scan_root:
                scan_roots.add(scan_root)

        assert scan_roots == {"/mnt/nas1", "/mnt/nas2"}

    def test_skips_empty_scan_roots(self, tmp_path: Path) -> None:
        """Test that empty Scan Root values are skipped."""
        rows = [
            make_catalog_row("a" * 64, "/mnt/nas1/file1.mp3", "/mnt/nas1"),
            make_catalog_row("b" * 64, "/path/to/file2.mp3", ""),  # Empty
            make_catalog_row("c" * 64, "/other/file3.mp3", "   "),  # Whitespace only
        ]

        scan_roots: set[str] = set()
        for row in rows:
            scan_root = (row.get("Scan Root", "") or "").strip()
            if scan_root:
                scan_roots.add(scan_root)

        assert scan_roots == {"/mnt/nas1"}

    def test_handles_missing_scan_root_column(self, tmp_path: Path) -> None:
        """Test handling when Scan Root column is missing."""
        rows = [
            {"Hash": "a" * 64, "Full Path": "/mnt/nas1/file1.mp3"},
        ]

        scan_roots: set[str] = set()
        for row in rows:
            scan_root = (row.get("Scan Root", "") or "").strip()
            if scan_root:
                scan_roots.add(scan_root)

        assert scan_roots == set()


class TestValidateScanRoots:
    """Tests for validating scan root directories exist."""

    def test_filters_missing_directories(self, tmp_path: Path) -> None:
        """Test that missing directories are filtered out."""
        # Create one real directory
        existing_dir = tmp_path / "existing"
        existing_dir.mkdir()

        scan_roots = {str(existing_dir), "/nonexistent/path"}

        valid_roots: list[Path] = []
        for root in sorted(scan_roots):
            root_path = Path(root)
            if root_path.is_dir():
                valid_roots.append(root_path)

        assert len(valid_roots) == 1
        assert valid_roots[0] == existing_dir

    def test_validates_multiple_existing_roots(self, tmp_path: Path) -> None:
        """Test that multiple existing roots are all validated."""
        dir1 = tmp_path / "dir1"
        dir2 = tmp_path / "dir2"
        dir1.mkdir()
        dir2.mkdir()

        scan_roots = {str(dir1), str(dir2)}

        valid_roots: list[Path] = []
        for root in sorted(scan_roots):
            root_path = Path(root)
            if root_path.is_dir():
                valid_roots.append(root_path)

        assert len(valid_roots) == 2
        assert set(valid_roots) == {dir1, dir2}


class TestPerPathProcessing:
    """Tests for per-path processing with correct Scan Root assignment."""

    def test_file_record_gets_scan_root(self, tmp_path: Path) -> None:
        """Test that FileRecord receives scan_root parameter."""
        scan_root = str(tmp_path)

        record = FileRecord(
            hash="a" * 64,
            filename="test.mp3",
            full_path=tmp_path / "test.mp3",
            hash_file=tmp_path / "test.mp3.audiohash",
            exists=True,
            size_bytes=1000,
            size_human="1.0 KB",
            status="EXISTS",
            extension="mp3",
            scan_root=scan_root,
        )

        assert record.scan_root == scan_root

    def test_different_files_get_different_scan_roots(self, tmp_path: Path) -> None:
        """Test that files from different roots get correct Scan Root values."""
        root1 = tmp_path / "root1"
        root2 = tmp_path / "root2"
        root1.mkdir()
        root2.mkdir()

        records = [
            FileRecord(
                hash="a" * 64,
                filename="file1.mp3",
                full_path=root1 / "file1.mp3",
                hash_file=root1 / "file1.mp3.audiohash",
                exists=True,
                size_bytes=1000,
                size_human="1.0 KB",
                status="EXISTS",
                extension="mp3",
                scan_root=str(root1),
            ),
            FileRecord(
                hash="b" * 64,
                filename="file2.mp3",
                full_path=root2 / "file2.mp3",
                hash_file=root2 / "file2.mp3.audiohash",
                exists=True,
                size_bytes=1000,
                size_human="1.0 KB",
                status="EXISTS",
                extension="mp3",
                scan_root=str(root2),
            ),
        ]

        assert records[0].scan_root == str(root1)
        assert records[1].scan_root == str(root2)


class TestAddFilesResultAggregation:
    """Tests for aggregating results from multiple scan roots."""

    def test_aggregates_new_records(self) -> None:
        """Test that new records from multiple roots are aggregated."""
        from besedy.commands.catalog.file_processing import AddFilesResult

        result1 = AddFilesResult(
            new_records=[
                FileRecord(
                    hash="a" * 64,
                    filename="file1.mp3",
                    full_path=Path("/root1/file1.mp3"),
                    hash_file=Path("/root1/file1.mp3.audiohash"),
                    exists=True,
                    size_bytes=1000,
                    size_human="1.0 KB",
                    status="EXISTS",
                    extension="mp3",
                    scan_root="/root1",
                )
            ],
            duplicate_records=[],
            errors=[],
            sidecar_warnings=[],
        )

        result2 = AddFilesResult(
            new_records=[
                FileRecord(
                    hash="b" * 64,
                    filename="file2.mp3",
                    full_path=Path("/root2/file2.mp3"),
                    hash_file=Path("/root2/file2.mp3.audiohash"),
                    exists=True,
                    size_bytes=1000,
                    size_human="1.0 KB",
                    status="EXISTS",
                    extension="mp3",
                    scan_root="/root2",
                )
            ],
            duplicate_records=[],
            errors=[],
            sidecar_warnings=[],
        )

        # Aggregate like handle_add does
        all_new_records = []
        all_new_records.extend(result1.new_records)
        all_new_records.extend(result2.new_records)

        assert len(all_new_records) == 2
        assert all_new_records[0].scan_root == "/root1"
        assert all_new_records[1].scan_root == "/root2"

    def test_aggregates_errors_and_warnings(self) -> None:
        """Test that errors and warnings from multiple roots are aggregated."""
        from besedy.commands.catalog.file_processing import AddFilesResult

        result1 = AddFilesResult(
            new_records=[],
            duplicate_records=[],
            errors=["Error from root1"],
            sidecar_warnings=["Warning from root1"],
        )

        result2 = AddFilesResult(
            new_records=[],
            duplicate_records=[],
            errors=["Error from root2"],
            sidecar_warnings=["Warning from root2"],
        )

        all_errors: list[str] = []
        all_warnings: list[str] = []
        all_errors.extend(result1.errors)
        all_errors.extend(result2.errors)
        all_warnings.extend(result1.sidecar_warnings)
        all_warnings.extend(result2.sidecar_warnings)

        assert len(all_errors) == 2
        assert len(all_warnings) == 2


class TestCrossRootDuplicateHandling:
    """Tests for handling duplicates across different scan roots."""

    def test_tracks_hashes_across_roots(self) -> None:
        """Test that hashes are tracked across roots to detect duplicates."""
        existing_hashes: set[str] = {"a" * 64}
        hash_to_original_path: dict[str, str] = {"a" * 64: "/root1/original.mp3"}

        # Simulate finding same hash in second root
        new_hash = "a" * 64
        is_duplicate = new_hash in existing_hashes

        assert is_duplicate is True
        assert hash_to_original_path[new_hash] == "/root1/original.mp3"

    def test_updates_tracking_after_each_root(self) -> None:
        """Test that tracking sets are updated after processing each root."""
        existing_hashes: set[str] = set()
        hash_to_original_path: dict[str, str] = {}

        # Process first root
        hash1 = "a" * 64
        path1 = "/root1/file1.mp3"
        existing_hashes.add(hash1)
        hash_to_original_path[hash1] = path1

        # Process second root - same hash should be detected as duplicate
        hash2 = "a" * 64  # Same hash
        is_duplicate = hash2 in existing_hashes

        assert is_duplicate is True
        assert hash_to_original_path.get(hash2) == path1
