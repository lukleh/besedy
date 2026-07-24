"""Tests for besedy/lib/catalog/validator.py.

Tests cover:
- Duration string parsing
- Catalog CSV loading
- Staged file checking
- Orphan file detection
- Backend directory discovery
- Transcript and diarization collection
- Full catalog validation
- Report formatting
"""

from __future__ import annotations

import csv
from pathlib import Path

from besedy.lib.catalog.validator import (
    CatalogEntry,
    DiarizationSet,
    StagedFile,
    TranscriptSet,
    ValidationResult,
    check_staged_files,
    collect_diarizations_by_hash,
    collect_transcripts_by_hash,
    discover_backend_directories,
    find_orphaned_staged_files,
    format_validation_report,
    load_catalog_csv,
    parse_duration,
    validate_catalog,
)


class TestParseDuration:
    """Tests for parse_duration function."""

    def test_hh_mm_ss_format(self):
        """Test HH:MM:SS format parsing."""
        assert parse_duration("01:30:45") == 5445.0  # 1*3600 + 30*60 + 45
        assert parse_duration("00:00:00") == 0.0
        assert parse_duration("10:00:00") == 36000.0

    def test_mm_ss_format(self):
        """Test MM:SS format parsing."""
        assert parse_duration("05:30") == 330.0  # 5*60 + 30
        assert parse_duration("00:45") == 45.0
        assert parse_duration("90:00") == 5400.0  # 90 minutes

    def test_seconds_only(self):
        """Test seconds-only format."""
        assert parse_duration("45") == 45.0
        assert parse_duration("120") == 120.0
        assert parse_duration("0") == 0.0

    def test_decimal_seconds(self):
        """Test decimal seconds."""
        assert parse_duration("45.5") == 45.5
        assert parse_duration("00:01:30.5") == 90.5

    def test_empty_string(self):
        """Test empty string returns 0."""
        assert parse_duration("") == 0.0
        assert parse_duration("   ") == 0.0

    def test_invalid_format(self):
        """Test invalid format returns 0."""
        assert parse_duration("invalid") == 0.0
        assert parse_duration("abc:def") == 0.0
        assert parse_duration("1:2:3:4") == 0.0  # Too many parts

    def test_strips_whitespace(self):
        """Test whitespace is stripped."""
        assert parse_duration("  01:30:00  ") == 5400.0


class TestCatalogEntry:
    """Tests for CatalogEntry dataclass."""

    def test_basic_creation(self):
        """Test creating a CatalogEntry."""
        entry = CatalogEntry(
            sha256="abc123",
            filename="test.wav",
            full_path="/path/to/test.wav",
            duration_str="01:30:00",
            duration_seconds=5400.0,
        )
        assert entry.sha256 == "abc123"
        assert entry.filename == "test.wav"
        assert entry.full_path == "/path/to/test.wav"
        assert entry.duration_str == "01:30:00"
        assert entry.duration_seconds == 5400.0


class TestStagedFile:
    """Tests for StagedFile dataclass."""

    def test_basic_creation(self):
        """Test creating a StagedFile."""
        staged = StagedFile(
            sha256="abc123",
            path=Path("/path/to/staged.wav"),
            exists=True,
            size_bytes=1024,
        )
        assert staged.sha256 == "abc123"
        assert staged.path == Path("/path/to/staged.wav")
        assert staged.exists is True
        assert staged.size_bytes == 1024

    def test_missing_file(self):
        """Test StagedFile for missing file."""
        staged = StagedFile(
            sha256="missing123",
            path=Path("/path/to/missing.wav"),
            exists=False,
            size_bytes=None,
        )
        assert staged.exists is False
        assert staged.size_bytes is None


class TestTranscriptSet:
    """Tests for TranscriptSet dataclass."""

    def test_basic_creation(self):
        """Test creating a TranscriptSet."""
        ts = TranscriptSet(
            sha256="abc123",
            backends=["canary-nemo/model1", "faster-whisper/model2"],
            paths=[Path("/path/1/transcript.json"), Path("/path/2/transcript.json")],
        )
        assert ts.sha256 == "abc123"
        assert len(ts.backends) == 2
        assert len(ts.paths) == 2


class TestDiarizationSet:
    """Tests for DiarizationSet dataclass."""

    def test_basic_creation(self):
        """Test creating a DiarizationSet."""
        ds = DiarizationSet(
            sha256="abc123",
            backends=["speaker_diarization/pyannote_model"],
            paths=[Path("/path/speakers.json")],
        )
        assert ds.sha256 == "abc123"
        assert len(ds.backends) == 1


class TestLoadCatalogCsv:
    """Tests for load_catalog_csv function."""

    def test_load_valid_csv(self, tmp_path):
        """Test loading a valid catalog CSV."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            """Hash,Filename,Full Path,Duration
abc123,test1.wav,/path/test1.wav,01:30:00
def456,test2.wav,/path/test2.wav,00:45:30
"""
        )

        entries = load_catalog_csv(csv_path)
        assert len(entries) == 2
        assert entries[0].sha256 == "abc123"
        assert entries[0].filename == "test1.wav"
        assert entries[0].duration_seconds == 5400.0
        assert entries[1].sha256 == "def456"
        assert entries[1].duration_seconds == 2730.0

    def test_skip_empty_hash(self, tmp_path):
        """Test that entries with empty hash are skipped."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            """Hash,Filename,Full Path,Duration
abc123,test1.wav,/path/test1.wav,01:00:00
,empty.wav,/path/empty.wav,00:30:00
  ,whitespace.wav,/path/whitespace.wav,00:30:00
"""
        )

        entries = load_catalog_csv(csv_path)
        assert len(entries) == 1
        assert entries[0].sha256 == "abc123"

    def test_empty_csv(self, tmp_path):
        """Test loading empty CSV (headers only)."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text("Hash,Filename,Full Path,Duration\n")

        entries = load_catalog_csv(csv_path)
        assert len(entries) == 0

    def test_missing_fields_handled(self, tmp_path):
        """Test that missing fields are handled gracefully."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            """Hash,Filename
abc123,test.wav
"""
        )

        entries = load_catalog_csv(csv_path)
        assert len(entries) == 1
        assert entries[0].sha256 == "abc123"
        assert entries[0].full_path == ""
        assert entries[0].duration_seconds == 0.0


class TestCheckStagedFiles:
    """Tests for check_staged_files function."""

    def test_existing_files(self, tmp_path):
        """Test checking existing staged files."""
        # Create staged file
        staged_file = tmp_path / "abc123.wav"
        staged_file.write_bytes(b"fake wav content")

        entries = [
            CatalogEntry(
                sha256="abc123",
                filename="test.wav",
                full_path=str(staged_file),
                duration_str="01:00:00",
                duration_seconds=3600.0,
            )
        ]

        staged_files, missing = check_staged_files(entries)

        assert "abc123" in staged_files
        assert staged_files["abc123"].exists is True
        assert staged_files["abc123"].size_bytes > 0
        assert len(missing) == 0

    def test_missing_files(self, tmp_path):
        """Test checking missing staged files."""
        entries = [
            CatalogEntry(
                sha256="missing123",
                filename="test.wav",
                full_path=str(tmp_path / "nonexistent.wav"),
                duration_str="01:00:00",
                duration_seconds=3600.0,
            )
        ]

        staged_files, missing = check_staged_files(entries)

        assert "missing123" in staged_files
        assert staged_files["missing123"].exists is False
        assert staged_files["missing123"].size_bytes is None
        assert "missing123" in missing

    def test_empty_path(self):
        """Test handling entries with empty path."""
        entries = [
            CatalogEntry(
                sha256="empty123",
                filename="test.wav",
                full_path="",
                duration_str="01:00:00",
                duration_seconds=3600.0,
            )
        ]

        staged_files, missing = check_staged_files(entries)

        assert "empty123" in staged_files
        assert staged_files["empty123"].exists is False
        assert "empty123" in missing


class TestFindOrphanedStagedFiles:
    """Tests for find_orphaned_staged_files function."""

    def test_find_orphans(self, tmp_path):
        """Test finding orphaned staged files."""
        # Create staged files
        (tmp_path / "abc123.wav").touch()
        (tmp_path / "def456.wav").touch()
        (tmp_path / "orphan789.wav").touch()

        catalog_hashes = {"abc123", "def456"}

        orphaned = find_orphaned_staged_files(tmp_path, catalog_hashes)

        assert len(orphaned) == 1
        assert "orphan789" in orphaned

    def test_no_orphans(self, tmp_path):
        """Test when no orphans exist."""
        (tmp_path / "abc123.wav").touch()
        (tmp_path / "def456.wav").touch()

        catalog_hashes = {"abc123", "def456"}

        orphaned = find_orphaned_staged_files(tmp_path, catalog_hashes)

        assert len(orphaned) == 0

    def test_none_directory(self):
        """Test with None directory."""
        orphaned = find_orphaned_staged_files(None, {"abc123"})
        assert orphaned == []

    def test_nonexistent_directory(self, tmp_path):
        """Test with nonexistent directory."""
        nonexistent = tmp_path / "nonexistent"
        orphaned = find_orphaned_staged_files(nonexistent, {"abc123"})
        assert orphaned == []


class TestDiscoverBackendDirectories:
    """Tests for discover_backend_directories function."""

    def test_discover_backends(self, tmp_path):
        """Test discovering backend directories."""
        # Create backend structure
        (tmp_path / "canary-nemo" / "model1").mkdir(parents=True)
        (tmp_path / "faster-whisper" / "model2").mkdir(parents=True)

        backends = discover_backend_directories(tmp_path)

        assert "canary-nemo/model1" in backends
        assert "faster-whisper/model2" in backends

    def test_skip_diarization_dirs(self, tmp_path):
        """Test that diarization directories are skipped."""
        (tmp_path / "canary-nemo" / "model1").mkdir(parents=True)
        (tmp_path / "speaker_diarization" / "pyannote").mkdir(parents=True)

        backends = discover_backend_directories(tmp_path)

        assert "canary-nemo/model1" in backends
        assert "speaker_diarization/pyannote" not in backends

    def test_skip_hidden_dirs(self, tmp_path):
        """Test that hidden directories are skipped."""
        (tmp_path / "canary-nemo" / "model1").mkdir(parents=True)
        (tmp_path / ".hidden" / "model").mkdir(parents=True)

        backends = discover_backend_directories(tmp_path)

        assert "canary-nemo/model1" in backends
        assert ".hidden/model" not in backends

    def test_nonexistent_root(self, tmp_path):
        """Test with nonexistent root directory."""
        nonexistent = tmp_path / "nonexistent"
        backends = discover_backend_directories(nonexistent)
        assert backends == set()


class TestCollectTranscriptsByHash:
    """Tests for collect_transcripts_by_hash function."""

    def test_collect_transcripts(self, tmp_path):
        """Test collecting transcripts by hash."""
        # Create transcript structure
        transcript_dir = tmp_path / "canary-nemo" / "model1" / "abc123"
        transcript_dir.mkdir(parents=True)
        (transcript_dir / "transcript.json").write_text("{}")

        transcript_dir2 = tmp_path / "faster-whisper" / "model2" / "abc123"
        transcript_dir2.mkdir(parents=True)
        (transcript_dir2 / "transcript.json").write_text("{}")

        result = collect_transcripts_by_hash(tmp_path)

        assert "abc123" in result
        assert len(result["abc123"].backends) == 2
        assert len(result["abc123"].paths) == 2

    def test_empty_directory(self, tmp_path):
        """Test with empty transcripts directory."""
        result = collect_transcripts_by_hash(tmp_path)
        assert result == {}


class TestCollectDiarizationsByHash:
    """Tests for collect_diarizations_by_hash function."""

    def test_collect_diarizations(self, tmp_path):
        """Test collecting diarizations by hash."""
        # Create diarization structure
        diar_dir = tmp_path / "speaker_diarization" / "pyannote_model" / "abc123"
        diar_dir.mkdir(parents=True)
        (diar_dir / "speakers.json").write_text("{}")

        result = collect_diarizations_by_hash(tmp_path)

        assert "abc123" in result
        assert len(result["abc123"].backends) == 1
        assert "speaker_diarization/pyannote_model" in result["abc123"].backends

    def test_no_diarization_dir(self, tmp_path):
        """Test when diarization directory doesn't exist."""
        result = collect_diarizations_by_hash(tmp_path)
        assert result == {}


class TestValidateCatalog:
    """Tests for validate_catalog function."""

    def _create_catalog_csv(self, path: Path, entries: list[dict]) -> None:
        """Helper to create catalog CSV file."""
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["Hash", "Filename", "Full Path", "Duration"])
            writer.writeheader()
            for entry in entries:
                writer.writerow(entry)

    def test_full_validation_all_present(self, tmp_path):
        """Test validation when all artifacts are present."""
        # Create catalog CSVs
        staging_dir = tmp_path / "staging"
        staging_dir.mkdir()
        staged_file = staging_dir / "abc123.wav"
        staged_file.write_bytes(b"fake wav content")

        catalog_csv = tmp_path / "catalog.csv"
        self._create_catalog_csv(
            catalog_csv,
            [
                {
                    "Hash": "abc123",
                    "Filename": "test.wav",
                    "Full Path": str(tmp_path / "original.wav"),
                    "Duration": "01:00:00",
                }
            ],
        )

        normalized_csv = tmp_path / "catalog_normalized.csv"
        self._create_catalog_csv(
            normalized_csv,
            [
                {
                    "Hash": "abc123",
                    "Filename": "abc123.wav",
                    "Full Path": str(staged_file),
                    "Duration": "01:00:00",
                }
            ],
        )

        # Create original file
        (tmp_path / "original.wav").write_bytes(b"original content")

        # Create transcripts
        transcripts_dir = tmp_path / "transcripts"
        transcript_path = transcripts_dir / "canary-nemo" / "model" / "abc123"
        transcript_path.mkdir(parents=True)
        (transcript_path / "transcript.json").write_text("{}")

        result = validate_catalog(
            catalog_csv,
            normalized_csv,
            transcripts_dir,
            expected_backends=["canary-nemo/model"],
        )

        assert result.catalog_entries == 1
        assert result.normalized_entries == 1
        assert result.staged_files_found == 1
        assert result.staged_files_missing == 0
        assert result.transcripts_found == 1
        assert result.entries_with_all_backends == 1

    def test_validation_missing_normalized(self, tmp_path):
        """Test validation when normalized entries are missing."""
        catalog_csv = tmp_path / "catalog.csv"
        self._create_catalog_csv(
            catalog_csv,
            [
                {
                    "Hash": "abc123",
                    "Filename": "test.wav",
                    "Full Path": str(tmp_path / "original.wav"),
                    "Duration": "01:00:00",
                }
            ],
        )

        normalized_csv = tmp_path / "catalog_normalized.csv"
        self._create_catalog_csv(normalized_csv, [])  # Empty

        transcripts_dir = tmp_path / "transcripts"
        transcripts_dir.mkdir()

        result = validate_catalog(catalog_csv, normalized_csv, transcripts_dir)

        assert result.catalog_entries == 1
        assert result.normalized_entries == 0
        assert len(result.missing_normalized_hashes) == 1
        assert "abc123" in result.missing_normalized_hashes


class TestFormatValidationReport:
    """Tests for format_validation_report function."""

    def test_clean_report(self):
        """Test formatting report with no issues."""
        result = ValidationResult(
            catalog_entries=10,
            normalized_entries=10,
            staged_files_found=10,
            staged_files_missing=0,
            transcripts_found=10,
            transcripts_missing=0,
            orphaned_staged=0,
            orphaned_transcripts=0,
            missing_hashes=[],
            missing_normalized_hashes=[],
            missing_original_hashes=[],
            normalized_only_hashes=[],
            orphaned_staged_hashes=[],
            orphaned_transcript_hashes=[],
            entries_with_all_backends=10,
            entries_missing_backends=[],
            diarization_found=10,
            diarization_missing=0,
            orphaned_diarization=0,
            missing_diarization_hashes=[],
            orphaned_diarization_hashes=[],
            entries_with_all_diarization_backends=10,
            entries_missing_diarization_backends=[],
            backend_counts={"canary-nemo/model": 10},
            diarization_backend_counts={"speaker_diarization/pyannote": 10},
        )

        report, issues_found = format_validation_report(result)

        assert "CATALOG VALIDATION REPORT" in report
        assert "10" in report
        assert not issues_found  # All good

    def test_report_with_issues(self):
        """Test formatting report with issues."""
        result = ValidationResult(
            catalog_entries=10,
            normalized_entries=8,  # Missing 2
            staged_files_found=7,
            staged_files_missing=3,
            transcripts_found=5,
            transcripts_missing=5,
            orphaned_staged=2,
            orphaned_transcripts=1,
            missing_hashes=["hash1", "hash2", "hash3"],
            missing_normalized_hashes=["hash1", "hash2"],
            missing_original_hashes=[("hash3", "/path/missing.wav")],
            normalized_only_hashes=[],
            orphaned_staged_hashes=["orphan1", "orphan2"],
            orphaned_transcript_hashes=["orphan3"],
            entries_with_all_backends=5,
            entries_missing_backends=[("hash4", ["canary-nemo/model"])],
            diarization_found=5,
            diarization_missing=5,
            orphaned_diarization=0,
            missing_diarization_hashes=["hash5"],
            orphaned_diarization_hashes=[],
            entries_with_all_diarization_backends=5,
            entries_missing_diarization_backends=[],
            backend_counts={"canary-nemo/model": 5},
            diarization_backend_counts={},
        )

        report, issues_found = format_validation_report(result)

        assert "CATALOG VALIDATION REPORT" in report
        assert issues_found  # Issues present

    def test_verbose_report(self):
        """Test verbose report includes additional details."""
        result = ValidationResult(
            catalog_entries=2,
            normalized_entries=2,
            staged_files_found=2,
            staged_files_missing=0,
            transcripts_found=2,
            transcripts_missing=0,
            orphaned_staged=0,
            orphaned_transcripts=0,
            missing_hashes=[],
            missing_normalized_hashes=[],
            missing_original_hashes=[],
            normalized_only_hashes=[],
            orphaned_staged_hashes=[],
            orphaned_transcript_hashes=[],
            entries_with_all_backends=2,
            entries_missing_backends=[],
            diarization_found=2,
            diarization_missing=0,
            orphaned_diarization=0,
            missing_diarization_hashes=[],
            orphaned_diarization_hashes=[],
            entries_with_all_diarization_backends=2,
            entries_missing_diarization_backends=[],
            backend_counts={},
            diarization_backend_counts={},
        )

        report, _ = format_validation_report(result, verbose=True)
        assert "CATALOG VALIDATION REPORT" in report


class TestValidationResultDataclass:
    """Tests for ValidationResult dataclass fields."""

    def test_all_fields_present(self):
        """Test that ValidationResult has all required fields."""
        result = ValidationResult(
            catalog_entries=0,
            normalized_entries=0,
            staged_files_found=0,
            staged_files_missing=0,
            transcripts_found=0,
            transcripts_missing=0,
            orphaned_staged=0,
            orphaned_transcripts=0,
            missing_hashes=[],
            missing_normalized_hashes=[],
            missing_original_hashes=[],
            normalized_only_hashes=[],
            orphaned_staged_hashes=[],
            orphaned_transcript_hashes=[],
            entries_with_all_backends=0,
            entries_missing_backends=[],
            diarization_found=0,
            diarization_missing=0,
            orphaned_diarization=0,
            missing_diarization_hashes=[],
            orphaned_diarization_hashes=[],
            entries_with_all_diarization_backends=0,
            entries_missing_diarization_backends=[],
            backend_counts={},
            diarization_backend_counts={},
        )

        # Verify all fields are accessible
        assert result.catalog_entries == 0
        assert result.normalized_entries == 0
        assert result.backend_counts == {}


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    def test_duration_with_leading_zeros(self):
        """Test duration parsing with leading zeros."""
        assert parse_duration("00:05:09") == 309.0  # 5 min 9 sec
        assert parse_duration("09:00:00") == 32400.0  # 9 hours

    def test_very_long_duration(self):
        """Test parsing very long durations."""
        # 99 hours, 59 min, 59 sec
        assert parse_duration("99:59:59") == 359999.0

    def test_catalog_with_unicode(self, tmp_path):
        """Test catalog loading with Unicode filenames."""
        csv_path = tmp_path / "catalog.csv"
        csv_path.write_text(
            """Hash,Filename,Full Path,Duration
abc123,příliš_žluťoučký.wav,/path/příliš_žluťoučký.wav,01:00:00
""",
            encoding="utf-8",
        )

        entries = load_catalog_csv(csv_path)
        assert len(entries) == 1
        assert "příliš" in entries[0].filename

    def test_multiple_transcripts_same_hash(self, tmp_path):
        """Test handling multiple backends for same audio hash."""
        # Create multiple backend transcripts
        for backend in ["canary-nemo/model1", "faster-whisper/model2", "whisperx/model3"]:
            parts = backend.split("/")
            transcript_dir = tmp_path / parts[0] / parts[1] / "abc123"
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "transcript.json").write_text("{}")

        result = collect_transcripts_by_hash(tmp_path)

        assert "abc123" in result
        assert len(result["abc123"].backends) == 3

    def test_orphan_detection_ignores_non_wav(self, tmp_path):
        """Test that orphan detection only considers .wav files."""
        (tmp_path / "abc123.wav").touch()
        (tmp_path / "orphan.wav").touch()
        (tmp_path / "readme.txt").touch()
        (tmp_path / "data.json").touch()

        catalog_hashes = {"abc123"}

        orphaned = find_orphaned_staged_files(tmp_path, catalog_hashes)

        assert len(orphaned) == 1
        assert "orphan" in orphaned
