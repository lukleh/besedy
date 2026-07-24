"""Tests for besedy/lib/catalog/cleaner.py.

Tests cover:
- CleanupTarget, CleanupPlan, CleanupResult dataclasses
- Missing original detection
- Staged file finding
- Transcript directory finding
- Diarization directory finding
- Sidecar file finding
- Cleanup plan building
"""

from __future__ import annotations

from besedy.lib.catalog.cleaner import (
    CleanupPlan,
    CleanupResult,
    CleanupTarget,
    build_cleanup_plan,
    detect_missing_originals,
    find_diarization_dirs,
    find_sidecar_files,
    find_staged_file,
    find_transcript_dirs,
)


class TestCleanupTarget:
    """Tests for CleanupTarget dataclass."""

    def test_basic_creation(self):
        """Test creating a CleanupTarget."""
        target = CleanupTarget(
            sha256="abc123",
            original_path="/path/to/original.wav",
        )
        assert target.sha256 == "abc123"
        assert target.original_path == "/path/to/original.wav"
        assert target.staged_path is None
        assert target.staged_exists is False
        assert target.transcript_dirs == []
        assert target.diarization_dirs == []
        assert target.sidecar_files == []

    def test_with_all_fields(self, tmp_path):
        """Test CleanupTarget with all fields populated."""
        staged = tmp_path / "staged.wav"
        transcript_dir = tmp_path / "transcripts"
        diarization_dir = tmp_path / "diarization"

        target = CleanupTarget(
            sha256="abc123",
            original_path="/path/to/original.wav",
            staged_path=staged,
            staged_exists=True,
            transcript_dirs=[transcript_dir],
            diarization_dirs=[diarization_dir],
            sidecar_files=[],
        )

        assert target.staged_path == staged
        assert target.staged_exists is True
        assert len(target.transcript_dirs) == 1


class TestCleanupPlan:
    """Tests for CleanupPlan dataclass."""

    def test_basic_creation(self, tmp_path):
        """Test creating a CleanupPlan."""
        plan = CleanupPlan(
            targets=[],
            catalog_csv=tmp_path / "catalog.csv",
            normalized_csv=tmp_path / "catalog_normalized.csv",
        )
        assert plan.targets == []
        assert plan.total_staged == 0
        assert plan.potential_mount_issue is False

    def test_with_statistics(self, tmp_path):
        """Test CleanupPlan with statistics."""
        plan = CleanupPlan(
            targets=[],
            catalog_csv=tmp_path / "catalog.csv",
            normalized_csv=None,
            total_staged=5,
            total_transcript_dirs=10,
            total_diarization_dirs=3,
            total_sidecar_files=20,
            potential_mount_issue=True,
            suspect_parent_dirs=["/mnt/media"],
        )

        assert plan.total_staged == 5
        assert plan.total_transcript_dirs == 10
        assert plan.potential_mount_issue is True
        assert "/mnt/media" in plan.suspect_parent_dirs


class TestCleanupResult:
    """Tests for CleanupResult dataclass."""

    def test_default_values(self):
        """Test CleanupResult default values."""
        result = CleanupResult()
        assert result.hashes_removed == 0
        assert result.hashes_failed == 0
        assert result.succeeded_hashes == []
        assert result.failed_hashes == []
        assert result.errors == []

    def test_with_values(self):
        """Test CleanupResult with values."""
        result = CleanupResult(
            hashes_removed=5,
            hashes_failed=1,
            staged_removed=4,
            transcript_dirs_removed=10,
            succeeded_hashes=["a", "b", "c", "d", "e"],
            failed_hashes=["f"],
            errors=["Failed to remove hash f: permission denied"],
        )

        assert result.hashes_removed == 5
        assert result.hashes_failed == 1
        assert len(result.errors) == 1


class TestDetectMissingOriginals:
    """Tests for detect_missing_originals function."""

    def test_no_missing(self, tmp_path):
        """Test when all originals exist."""
        file1 = tmp_path / "audio1.wav"
        file2 = tmp_path / "audio2.wav"
        file1.touch()
        file2.touch()

        entries = [
            ("hash1", str(file1)),
            ("hash2", str(file2)),
        ]

        missing, mount_issue, suspects = detect_missing_originals(entries)

        assert missing == []
        assert mount_issue is False
        assert suspects == []

    def test_some_missing(self, tmp_path):
        """Test when some originals are missing."""
        existing = tmp_path / "existing.wav"
        existing.touch()

        entries = [
            ("hash1", str(existing)),
            ("hash2", str(tmp_path / "missing.wav")),
        ]

        missing, mount_issue, suspects = detect_missing_originals(entries)

        assert len(missing) == 1
        assert missing[0][0] == "hash2"
        assert mount_issue is False

    def test_potential_mount_issue(self, tmp_path):
        """Test detection of potential mount issue."""
        # All files under a non-existent parent (simulating unmounted volume)
        entries = [
            ("hash1", "/mnt/missing_volume/audio1.wav"),
            ("hash2", "/mnt/missing_volume/audio2.wav"),
            ("hash3", "/mnt/missing_volume/subdir/audio3.wav"),
        ]

        missing, mount_issue, suspects = detect_missing_originals(entries)

        assert len(missing) == 3
        assert mount_issue is True
        assert len(suspects) > 0

    def test_empty_entries(self):
        """Test with empty entries list."""
        missing, mount_issue, suspects = detect_missing_originals([])
        assert missing == []
        assert mount_issue is False
        assert suspects == []

    def test_mount_issue_with_shared_parent(self, tmp_path):
        """Many missing files under the same non-existent parent must
        still trigger the mount-issue flag.

        The old code compared ``len(suspect_parents)`` (unique dirs)
        against ``len(missing)`` — if all files shared one parent, the
        set size was 1 and the 50% threshold was never reached.
        """
        entries = [
            (f"hash{i}", f"/mnt/missing_volume/audio{i}.wav")
            for i in range(10)
        ]

        missing, mount_issue, suspects = detect_missing_originals(entries)

        assert len(missing) == 10
        assert mount_issue is True
        assert len(suspects) == 1


class TestFindStagedFile:
    """Tests for find_staged_file function."""

    def test_finds_existing_file(self, tmp_path):
        """Test finding existing staged file."""
        staged_file = tmp_path / "abc123.wav"
        staged_file.touch()

        result = find_staged_file(tmp_path, "abc123")

        assert result == staged_file

    def test_returns_none_for_missing(self, tmp_path):
        """Test returns None for missing staged file."""
        result = find_staged_file(tmp_path, "nonexistent")
        assert result is None

    def test_correct_pattern(self, tmp_path):
        """Test uses correct filename pattern."""
        # Create wrong extension
        (tmp_path / "abc123.mp3").touch()

        result = find_staged_file(tmp_path, "abc123")

        assert result is None  # Should only look for .wav

    def test_skips_directory_at_expected_path(self, tmp_path):
        """A directory named <hash>.wav must not be returned as a staged file."""
        (tmp_path / "abc123.wav").mkdir()

        result = find_staged_file(tmp_path, "abc123")

        assert result is None

    def test_skips_fifo_at_expected_path(self, tmp_path):
        """A FIFO at the expected path must not be returned as a staged file."""
        import os

        fifo_path = tmp_path / "abc123.wav"
        os.mkfifo(fifo_path)

        result = find_staged_file(tmp_path, "abc123")

        assert result is None

    def test_skips_broken_symlink(self, tmp_path):
        """A broken symlink at the expected path must be treated as missing."""
        (tmp_path / "abc123.wav").symlink_to(tmp_path / "nonexistent.wav")

        result = find_staged_file(tmp_path, "abc123")

        assert result is None


class TestFindTranscriptDirs:
    """Tests for find_transcript_dirs function."""

    def test_finds_transcript_directories(self, tmp_path):
        """Test finding transcript directories."""
        # Create transcript structure
        dir1 = tmp_path / "canary-nemo" / "model1" / "abc123"
        dir1.mkdir(parents=True)
        dir2 = tmp_path / "faster-whisper" / "model2" / "abc123"
        dir2.mkdir(parents=True)

        result = find_transcript_dirs(tmp_path, "abc123")

        assert len(result) == 2
        assert dir1 in result
        assert dir2 in result

    def test_skips_diarization_directory(self, tmp_path):
        """Test that speaker_diarization directory is skipped."""
        # Create transcript and diarization directories
        transcript_dir = tmp_path / "canary-nemo" / "model" / "abc123"
        transcript_dir.mkdir(parents=True)
        diar_dir = tmp_path / "speaker_diarization" / "pyannote" / "abc123"
        diar_dir.mkdir(parents=True)

        result = find_transcript_dirs(tmp_path, "abc123")

        assert len(result) == 1
        assert transcript_dir in result
        assert diar_dir not in result

    def test_nonexistent_root(self, tmp_path):
        """Test with nonexistent transcripts root."""
        nonexistent = tmp_path / "nonexistent"
        result = find_transcript_dirs(nonexistent, "abc123")
        assert result == []

    def test_no_matching_hash(self, tmp_path):
        """Test when no directories match the hash."""
        dir1 = tmp_path / "canary-nemo" / "model" / "other_hash"
        dir1.mkdir(parents=True)

        result = find_transcript_dirs(tmp_path, "abc123")
        assert result == []

    def test_finds_in_timestamped_directories(self, tmp_path):
        """Test finding transcripts in timestamped directories."""
        # Create timestamped transcript structure (common in production)
        ts_dir = tmp_path / "transcripts_20251222_144441"
        dir1 = ts_dir / "canary-nemo" / "model1" / "abc123"
        dir1.mkdir(parents=True)
        dir2 = ts_dir / "faster-whisper" / "model2" / "abc123"
        dir2.mkdir(parents=True)

        # Also create another timestamped directory with different hash
        ts_dir2 = tmp_path / "transcripts_20251111_143632"
        dir3 = ts_dir2 / "canary-nemo" / "model1" / "abc123"
        dir3.mkdir(parents=True)

        result = find_transcript_dirs(tmp_path, "abc123")

        # Should find all 3 directories across both timestamped dirs
        assert len(result) == 3
        assert dir1 in result
        assert dir2 in result
        assert dir3 in result

    def test_finds_in_both_direct_and_timestamped(self, tmp_path):
        """Test finding transcripts in both direct and timestamped structures."""
        # Direct structure
        direct_dir = tmp_path / "canary-nemo" / "model" / "abc123"
        direct_dir.mkdir(parents=True)

        # Timestamped structure
        ts_dir = tmp_path / "transcripts_20251222_144441"
        ts_transcript_dir = ts_dir / "faster-whisper" / "model" / "abc123"
        ts_transcript_dir.mkdir(parents=True)

        result = find_transcript_dirs(tmp_path, "abc123")

        assert len(result) == 2
        assert direct_dir in result
        assert ts_transcript_dir in result


class TestFindDiarizationDirs:
    """Tests for find_diarization_dirs function."""

    def test_finds_diarization_directories(self, tmp_path):
        """Test finding diarization directories."""
        # Create diarization structure
        diar_dir = tmp_path / "speaker_diarization" / "pyannote_model" / "abc123"
        diar_dir.mkdir(parents=True)

        result = find_diarization_dirs(tmp_path, "abc123")

        assert len(result) == 1
        assert diar_dir in result

    def test_multiple_diarization_models(self, tmp_path):
        """Test finding diarization across multiple models."""
        dir1 = tmp_path / "speaker_diarization" / "model1" / "abc123"
        dir1.mkdir(parents=True)
        dir2 = tmp_path / "speaker_diarization" / "model2" / "abc123"
        dir2.mkdir(parents=True)

        result = find_diarization_dirs(tmp_path, "abc123")

        assert len(result) == 2

    def test_no_diarization_root(self, tmp_path):
        """Test when speaker_diarization directory doesn't exist."""
        result = find_diarization_dirs(tmp_path, "abc123")
        assert result == []

    def test_finds_in_timestamped_directories(self, tmp_path):
        """Test finding diarization in timestamped directories."""
        # Create timestamped diarization structure
        ts_dir = tmp_path / "transcripts_20251222_144441"
        diar_dir1 = ts_dir / "speaker_diarization" / "pyannote" / "abc123"
        diar_dir1.mkdir(parents=True)

        # Another timestamped directory
        ts_dir2 = tmp_path / "transcripts_20251111_143632"
        diar_dir2 = ts_dir2 / "speaker_diarization" / "pyannote" / "abc123"
        diar_dir2.mkdir(parents=True)

        result = find_diarization_dirs(tmp_path, "abc123")

        assert len(result) == 2
        assert diar_dir1 in result
        assert diar_dir2 in result


class TestFindSidecarFiles:
    """Tests for find_sidecar_files function."""

    def test_finds_sidecar_files(self, tmp_path):
        """Test finding transcript sidecar files."""
        # Create transcript directory with sidecars
        transcript_dir = tmp_path / "transcripts" / "abc123"
        transcript_dir.mkdir(parents=True)
        (transcript_dir / "transcript.txt").touch()
        (transcript_dir / "transcript.srt").touch()
        (transcript_dir / "transcript.vtt").touch()

        result = find_sidecar_files([transcript_dir])

        assert len(result) == 3

    def test_skips_non_sidecar_files(self, tmp_path):
        """Test that non-sidecar files are skipped."""
        transcript_dir = tmp_path / "transcripts" / "abc123"
        transcript_dir.mkdir(parents=True)
        (transcript_dir / "transcript.json").touch()  # Not a sidecar
        (transcript_dir / "other.txt").touch()  # Wrong name

        result = find_sidecar_files([transcript_dir])

        # Only sidecar files matching the pattern should be found
        assert all("transcript" in str(p.name) for p in result)

    def test_empty_directories(self, tmp_path):
        """Test with directories containing no sidecars."""
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()

        result = find_sidecar_files([empty_dir])
        assert result == []


class TestBuildCleanupPlan:
    """Tests for build_cleanup_plan function."""

    def test_build_plan_basic(self, tmp_path):
        """Test building a basic cleanup plan."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        missing_entries = [
            ("hash1", "/path/to/missing1.wav"),
            ("hash2", "/path/to/missing2.wav"),
        ]

        plan = build_cleanup_plan(
            missing_entries=missing_entries,
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=None,
            transcripts_root=tmp_path / "transcripts",
        )

        assert len(plan.targets) == 2
        assert plan.catalog_csv == catalog_csv

    def test_build_plan_with_staging(self, tmp_path):
        """Test building plan with staged files."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        staging_dir = tmp_path / "staging"
        staging_dir.mkdir()
        staged_file = staging_dir / "hash1.wav"
        staged_file.touch()

        missing_entries = [("hash1", "/path/to/missing.wav")]

        plan = build_cleanup_plan(
            missing_entries=missing_entries,
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=staging_dir,
            transcripts_root=tmp_path / "transcripts",
        )

        assert plan.targets[0].staged_exists is True
        assert plan.targets[0].staged_path == staged_file
        assert plan.total_staged == 1

    def test_build_plan_with_transcripts(self, tmp_path):
        """Test building plan with transcript directories."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        transcripts_root = tmp_path / "transcripts"
        transcript_dir = transcripts_root / "canary-nemo" / "model" / "hash1"
        transcript_dir.mkdir(parents=True)

        missing_entries = [("hash1", "/path/to/missing.wav")]

        plan = build_cleanup_plan(
            missing_entries=missing_entries,
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=None,
            transcripts_root=transcripts_root,
        )

        assert len(plan.targets[0].transcript_dirs) == 1
        assert plan.total_transcript_dirs == 1

    def test_build_plan_with_diarization(self, tmp_path):
        """Test building plan with diarization directories."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        transcripts_root = tmp_path / "transcripts"
        diar_dir = transcripts_root / "speaker_diarization" / "pyannote" / "hash1"
        diar_dir.mkdir(parents=True)

        missing_entries = [("hash1", "/path/to/missing.wav")]

        plan = build_cleanup_plan(
            missing_entries=missing_entries,
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=None,
            transcripts_root=transcripts_root,
        )

        assert len(plan.targets[0].diarization_dirs) == 1
        assert plan.total_diarization_dirs == 1

    def test_build_plan_empty_entries(self, tmp_path):
        """Test building plan with no missing entries."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        plan = build_cleanup_plan(
            missing_entries=[],
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=None,
            transcripts_root=tmp_path / "transcripts",
        )

        assert plan.targets == []
        assert plan.total_staged == 0


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    def test_missing_originals_with_unicode_paths(self, tmp_path):
        """Test detect_missing_originals with Unicode paths."""
        # Create a file with Unicode name
        unicode_file = tmp_path / "příliš_žluťoučký.wav"
        unicode_file.touch()

        entries = [
            ("hash1", str(unicode_file)),
            ("hash2", str(tmp_path / "missing_čeština.wav")),
        ]

        missing, mount_issue, suspects = detect_missing_originals(entries)

        assert len(missing) == 1
        assert "čeština" in missing[0][1]

    def test_staged_file_with_special_hash(self, tmp_path):
        """Test find_staged_file with various hash formats."""
        # SHA-256 hex string
        hash_val = "a" * 64
        staged_file = tmp_path / f"{hash_val}.wav"
        staged_file.touch()

        result = find_staged_file(tmp_path, hash_val)
        assert result == staged_file

    def test_transcript_dirs_ignores_files(self, tmp_path):
        """Test that find_transcript_dirs ignores files, not directories."""
        # Create a file that looks like a workflow
        (tmp_path / "canary-nemo").touch()  # File, not directory

        result = find_transcript_dirs(tmp_path, "abc123")
        assert result == []

    def test_cleanup_plan_statistics_accumulate(self, tmp_path):
        """Test that cleanup plan statistics accumulate correctly."""
        catalog_csv = tmp_path / "catalog.csv"
        catalog_csv.touch()

        staging_dir = tmp_path / "staging"
        staging_dir.mkdir()
        (staging_dir / "hash1.wav").touch()
        (staging_dir / "hash2.wav").touch()

        transcripts_root = tmp_path / "transcripts"
        (transcripts_root / "workflow" / "model" / "hash1").mkdir(parents=True)
        (transcripts_root / "workflow" / "model" / "hash2").mkdir(parents=True)

        missing_entries = [
            ("hash1", "/path/to/missing1.wav"),
            ("hash2", "/path/to/missing2.wav"),
        ]

        plan = build_cleanup_plan(
            missing_entries=missing_entries,
            catalog_csv=catalog_csv,
            normalized_csv=None,
            staging_dir=staging_dir,
            transcripts_root=transcripts_root,
        )

        assert plan.total_staged == 2
        assert plan.total_transcript_dirs == 2
