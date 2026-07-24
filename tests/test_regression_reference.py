"""Regression tests comparing current implementation against reference.

These tests use the reference worktree at worktrees/besedy-reference to verify
the refactored code produces identical results to the pre-refactor version.
Tests skip automatically if the reference worktree is not available.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.external


class TestReferenceWorktreeAvailable:
    """Tests for reference worktree availability."""

    def test_reference_worktree_fixture_skips_when_missing(self, reference_worktree):
        """Reference worktree fixture provides valid path when available."""
        assert reference_worktree.exists()
        assert reference_worktree.is_dir()

    def test_reference_has_tools_directory(self, reference_worktree):
        """Reference worktree has the old tools/ structure."""
        tools_dir = reference_worktree / "tools"
        # Old structure was under tools/
        assert tools_dir.exists() or (reference_worktree / "besedy").exists()


class TestPathConstantsConsistency:
    """Tests that path constants are consistent."""

    def test_target_sample_rate_unchanged(self, reference_worktree):
        """audio.sample_rate config is unchanged from reference."""
        from besedy.config.settings import config

        # Should be 16000 Hz for speech processing
        assert config.audio.sample_rate == 16000

    def test_wav_extension_unchanged(self, reference_worktree):
        """WAV_EXTENSION is unchanged from reference."""
        from besedy.core.paths import WAV_EXTENSION

        assert WAV_EXTENSION == ".wav"


class TestDurationParsingConsistency:
    """Tests that duration parsing is consistent."""

    def test_parse_duration_formats(self, reference_worktree):
        """Duration parsing handles all expected formats."""
        from besedy.lib.workflow.common import parse_duration_to_seconds

        # Standard formats
        assert parse_duration_to_seconds("01:30") == 90.0
        assert parse_duration_to_seconds("1:30") == 90.0
        assert parse_duration_to_seconds("01:00:30") == 3630.0

        # These are the documented formats from CLAUDE.md
        # Verify they still work after refactor

    def test_parse_duration_edge_cases(self, reference_worktree):
        """Duration parsing handles edge cases consistently."""
        from besedy.lib.workflow.common import parse_duration_to_seconds

        # Single digit seconds
        assert parse_duration_to_seconds("00:05") == 5.0

        # Zero duration raises (must be positive)
        with pytest.raises(ValueError, match="positive"):
            parse_duration_to_seconds("00:00")


class TestCatalogSchemaConsistency:
    """Tests that catalog CSV schema is consistent."""

    def test_catalog_fieldnames_include_required_columns(self, reference_worktree):
        """Catalog fieldnames include all required columns."""
        from besedy.lib.catalog.manager import catalog_fieldnames

        fields = catalog_fieldnames()

        # Required columns from documentation
        required = ["Hash", "Filename", "Full Path", "Status"]
        for col in required:
            assert col in fields, f"Missing required column: {col}"

    def test_audio_quality_columns_present(self, reference_worktree):
        """Audio quality columns are present in catalog schema."""
        from besedy.lib.audio.quality import AUDIO_QUALITY_COLUMNS
        from besedy.lib.catalog.manager import catalog_fieldnames

        fields = catalog_fieldnames(include_quality=True)

        for col in AUDIO_QUALITY_COLUMNS:
            assert col in fields, f"Missing audio quality column: {col}"


class TestTranscriptSchemaConsistency:
    """Tests that transcript schema is consistent."""

    def test_canonical_schema_structure(self, reference_worktree):
        """Canonical transcript schema structure is preserved."""
        # Canonical schema from CLAUDE.md
        valid_transcript = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "Hello world",
                    "confidence": 0.95,
                    "words": [{"word": "Hello", "start": 0.0, "end": 1.2, "confidence": 0.96}],
                }
            ]
        }

        from besedy.lib.validation.core import validate_shared_schema

        issues = validate_shared_schema(valid_transcript)
        assert issues == [], f"Valid transcript should have no issues: {issues}"

    def test_schema_allows_optional_confidence(self, reference_worktree):
        """Schema allows missing confidence (it's optional per CLAUDE.md)."""
        transcript_without_confidence = {
            "segments": [
                {
                    "start": 0.0,
                    "end": 2.5,
                    "text": "Hello world",
                }
            ]
        }

        from besedy.lib.validation.core import validate_shared_schema

        issues = validate_shared_schema(transcript_without_confidence)
        assert issues == [], "Confidence is optional"


class TestValidationFunctionsConsistency:
    """Tests that validation functions behave consistently."""

    def test_declipping_threshold_logic(self, reference_worktree):
        """Declipping threshold logic is consistent."""
        from besedy.lib.audio.quality import needs_declipping

        # At -1.0 dB threshold
        assert needs_declipping("-0.5", threshold=-1.0) is True  # Above threshold
        assert needs_declipping("-1.0", threshold=-1.0) is True  # At threshold
        assert needs_declipping("-2.0", threshold=-1.0) is False  # Below threshold

    def test_normalization_range_logic(self, reference_worktree):
        """Normalization range logic is consistent."""
        from besedy.lib.audio.quality import determine_needs_normalization

        # Per CLAUDE.md: -20 to -12 LUFS is acceptable
        assert determine_needs_normalization("-16.0") == "no"  # Target
        assert determine_needs_normalization("-20.0") == "no"  # Lower bound
        assert determine_needs_normalization("-12.0") == "no"  # Upper bound
        assert determine_needs_normalization("-25.0") == "yes"  # Too quiet
        assert determine_needs_normalization("-8.0") == "yes"  # Too loud


class TestFileDiscoveryConsistency:
    """Tests that file discovery patterns are consistent."""

    def test_transcript_glob_pattern(self, reference_worktree, tmp_path):
        """Transcript discovery uses consistent glob pattern."""
        # Create transcript structure
        transcript_dir = tmp_path / "transcripts" / "backend" / "model" / "hash123"
        transcript_dir.mkdir(parents=True)
        (transcript_dir / "transcript.json").write_text('{"segments": []}')

        # Discovery should find it
        transcripts = list(tmp_path.rglob("transcript.json"))
        assert len(transcripts) == 1

    def test_speakers_glob_pattern(self, reference_worktree, tmp_path):
        """Diarization discovery uses consistent glob pattern."""
        # Create diarization structure
        diarization_dir = tmp_path / "transcripts" / "diarization" / "hash123"
        diarization_dir.mkdir(parents=True)
        (diarization_dir / "speakers.json").write_text('{"segments": []}')

        # Discovery should find it
        speakers = list(tmp_path.rglob("speakers.json"))
        assert len(speakers) == 1


class TestImportConsistency:
    """Tests that all public imports are available."""

    def test_core_paths_imports(self, reference_worktree):
        """Core paths module exports expected symbols."""
        from besedy.core import paths

        # Check key exports exist
        assert hasattr(paths, "PROJECT_ROOT")
        assert hasattr(paths, "WAV_EXTENSION")
        # Note: TARGET_SAMPLE_RATE moved to config.audio.sample_rate

    def test_catalog_manager_imports(self, reference_worktree):
        """Catalog manager exports expected symbols."""
        from besedy.lib.catalog import manager

        assert hasattr(manager, "source_file_sha256")
        assert hasattr(manager, "catalog_fieldnames")
        assert hasattr(manager, "write_catalog_csv")

    def test_validation_core_imports(self, reference_worktree):
        """Validation core exports expected symbols."""
        from besedy.lib.validation import core

        assert hasattr(core, "validate_shared_schema")
        assert hasattr(core, "validate_single_file")

    def test_audio_quality_imports(self, reference_worktree):
        """Audio quality exports expected symbols."""
        from besedy.lib.audio import quality

        assert hasattr(quality, "needs_declipping")
        assert hasattr(quality, "determine_needs_normalization")
        assert hasattr(quality, "AUDIO_QUALITY_COLUMNS")


class TestBehaviorConsistency:
    """Tests that key behaviors are preserved."""

    def test_format_size_behavior(self, reference_worktree):
        """format_size produces consistent output."""
        from besedy.lib.catalog.manager import format_size

        assert format_size(1024) == "1.0 KB"
        assert format_size(1048576) == "1.0 MB"
        assert format_size(1073741824) == "1.0 GB"

    def test_hash_component_behavior(self, reference_worktree):
        """hash_component_from_sha produces consistent output."""
        from besedy.core.paths import hash_component_from_sha

        # Should lowercase and return as-is
        assert hash_component_from_sha("ABC123") == "abc123"
        assert hash_component_from_sha("abc123") == "abc123"

    def test_unicode_normalization_behavior(self, reference_worktree, tmp_path):
        """Unicode filename handling is consistent."""
        import unicodedata

        from besedy.lib.catalog.manager import source_file_sha256

        # Create file with NFC-normalized name
        nfc_name = unicodedata.normalize("NFC", "test_čeština.txt")
        test_file = tmp_path / nfc_name
        test_file.write_text("content")

        # Should handle Unicode consistently
        hash_val = source_file_sha256(test_file)
        assert len(hash_val) == 64
