"""End-to-end pipeline smoke tests with synthetic fixtures.

These tests verify the complete transcript processing pipeline works
by creating minimal synthetic fixtures and running through the key operations.
"""

from __future__ import annotations

import json

import pytest

from besedy.core.paths import (
    extract_timestamp_from_transcripts_root,
    iter_transcript_paths,
    parse_transcript_components,
)
from besedy.lib.validation.core import validate_shared_schema, validate_single_file


@pytest.fixture
def synthetic_transcripts_dir(tmp_path):
    """Create a complete synthetic transcript directory structure.

    Structure:
      transcripts_20251128_120000/
        faster-whisper/
          large-v3@silero_vad_v6/
            abc123def456/
              transcript.json
        canary-nemo/
          nvidia_canary-1b-v2[greedy]@frame_vad/
            abc123def456/
              transcript.json
        speaker_diarization/
          pyannote_speaker-diarization-community-1/
            abc123def456/
              speakers.json
    """
    root = tmp_path / "transcripts_20251128_120000"

    # Faster-Whisper transcript
    fw_dir = root / "faster-whisper" / "large-v3@silero_vad_v6" / "abc123def456"
    fw_dir.mkdir(parents=True)
    fw_transcript = {
        "segments": [
            {
                "start": 0.0,
                "end": 2.5,
                "text": "Hello world",
                "confidence": 0.95,
                "words": [
                    {"word": "Hello", "start": 0.0, "end": 1.2, "confidence": 0.96},
                    {"word": "world", "start": 1.3, "end": 2.5, "confidence": 0.94},
                ],
            },
            {
                "start": 3.0,
                "end": 5.0,
                "text": "How are you",
                "confidence": 0.90,
            },
        ]
    }
    (fw_dir / "transcript.json").write_text(json.dumps(fw_transcript, indent=2))

    # NeMo/Canary transcript
    nemo_dir = root / "canary-nemo" / "nvidia_canary-1b-v2[greedy]@frame_vad" / "abc123def456"
    nemo_dir.mkdir(parents=True)
    nemo_transcript = {
        "meta": {
            "backend": "canary-nemo",
            "model": "nvidia/canary-1b-v2",
            "audio_filepath": "/path/to/audio.wav",
        },
        "segments": [
            {"start": 0.0, "end": 2.5, "text": "Hello world", "confidence": 0.92},
            {"start": 3.0, "end": 5.0, "text": "How are you", "confidence": 0.88},
        ],
    }
    (nemo_dir / "transcript.json").write_text(json.dumps(nemo_transcript, indent=2))

    # Diarization output
    dia_dir = (
        root / "speaker_diarization" / "pyannote_speaker-diarization-community-1" / "abc123def456"
    )
    dia_dir.mkdir(parents=True)
    diarization = {
        "segments": [
            {"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"},
            {"start": 3.0, "end": 5.0, "speaker": "SPEAKER_01"},
        ]
    }
    (dia_dir / "speakers.json").write_text(json.dumps(diarization, indent=2))

    return root


class TestTranscriptIteration:
    """Tests for iterating over transcript files."""

    def test_finds_all_transcripts(self, synthetic_transcripts_dir):
        """iter_transcript_paths finds all transcript.json files."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        # Should find 2 transcript.json files (faster-whisper and canary-nemo)
        transcript_names = [p.name for p in paths]
        assert transcript_names.count("transcript.json") == 2

    def test_does_not_find_speakers_json(self, synthetic_transcripts_dir):
        """iter_transcript_paths does not return speakers.json."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        assert not any(p.name == "speakers.json" for p in paths)


class TestTranscriptComponentParsing:
    """Tests for parsing transcript path components."""

    def test_parses_faster_whisper_path(self, synthetic_transcripts_dir):
        """parse_transcript_components extracts workflow/model/hash."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        fw_path = next(p for p in paths if "faster-whisper" in str(p))

        result = parse_transcript_components(fw_path, synthetic_transcripts_dir)
        assert result is not None
        workflow, model, audio_hash = result
        assert workflow == "faster-whisper"
        assert "large-v3" in model
        assert audio_hash == "abc123def456"

    def test_parses_nemo_path(self, synthetic_transcripts_dir):
        """parse_transcript_components works for NeMo paths."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        nemo_path = next(p for p in paths if "canary-nemo" in str(p))

        result = parse_transcript_components(nemo_path, synthetic_transcripts_dir)
        assert result is not None
        workflow, model, audio_hash = result
        assert workflow == "canary-nemo"
        assert audio_hash == "abc123def456"


class TestSchemaValidation:
    """Tests for schema validation of synthetic transcripts."""

    def test_faster_whisper_transcript_valid(self, synthetic_transcripts_dir):
        """Faster-Whisper transcript passes schema validation."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        fw_path = next(p for p in paths if "faster-whisper" in str(p))

        data = json.loads(fw_path.read_text())
        issues = validate_shared_schema(data)
        assert issues == []

    def test_nemo_transcript_valid(self, synthetic_transcripts_dir):
        """NeMo transcript passes schema validation."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        nemo_path = next(p for p in paths if "canary-nemo" in str(p))

        data = json.loads(nemo_path.read_text())
        issues = validate_shared_schema(data)
        assert issues == []

    def test_validate_single_file_passes(self, synthetic_transcripts_dir):
        """validate_single_file works on synthetic transcripts."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))
        for path in paths:
            result = validate_single_file(path, quiet=True)
            assert result is True, f"Validation failed for {path}"


class TestTimestampExtraction:
    """Tests for timestamp extraction from directory names."""

    def test_extracts_timestamp_from_root(self, synthetic_transcripts_dir):
        """extract_timestamp_from_transcripts_root finds timestamp."""
        ts = extract_timestamp_from_transcripts_root(synthetic_transcripts_dir)
        assert ts == "20251128_120000"


class TestMultiBackendStructure:
    """Tests verifying multi-backend transcript structure."""

    def test_multiple_backends_same_hash(self, synthetic_transcripts_dir):
        """Same audio hash appears under multiple backends."""
        paths = list(iter_transcript_paths(synthetic_transcripts_dir))

        # Extract audio hashes
        hashes = set()
        for path in paths:
            result = parse_transcript_components(path, synthetic_transcripts_dir)
            if result:
                _, _, audio_hash = result
                hashes.add(audio_hash)

        # Both backends have same audio hash
        assert "abc123def456" in hashes
        # But we have multiple transcripts for it
        assert len(paths) == 2


class TestEmptyAndEdgeCases:
    """Tests for edge cases in transcript processing."""

    def test_empty_transcripts_dir(self, tmp_path):
        """Empty directory returns no transcripts."""
        empty_dir = tmp_path / "transcripts_20251128_000000"
        empty_dir.mkdir()

        paths = list(iter_transcript_paths(empty_dir))
        assert paths == []

    def test_nested_but_no_transcript_json(self, tmp_path):
        """Directory structure without transcript.json returns empty."""
        root = tmp_path / "transcripts_20251128_000000"
        nested = root / "backend" / "model" / "hash"
        nested.mkdir(parents=True)
        # Create some other file
        (nested / "metadata.json").write_text("{}")

        paths = list(iter_transcript_paths(root))
        assert paths == []

    def test_transcript_json_at_wrong_level(self, tmp_path):
        """transcript.json at root level is still found."""
        root = tmp_path / "transcripts_20251128_000000"
        root.mkdir()
        (root / "transcript.json").write_text('{"segments": []}')

        paths = list(iter_transcript_paths(root))
        assert len(paths) == 1


class TestDiarizationStructure:
    """Tests verifying diarization output structure."""

    def test_diarization_dir_exists(self, synthetic_transcripts_dir):
        """Diarization directory is created correctly."""
        dia_dir = synthetic_transcripts_dir / "speaker_diarization"
        assert dia_dir.exists()

    def test_speakers_json_exists(self, synthetic_transcripts_dir):
        """speakers.json file exists in diarization output."""
        speakers_files = list(synthetic_transcripts_dir.rglob("speakers.json"))
        assert len(speakers_files) == 1

    def test_speakers_json_valid_structure(self, synthetic_transcripts_dir):
        """speakers.json has valid structure."""
        speakers_file = next(synthetic_transcripts_dir.rglob("speakers.json"))
        data = json.loads(speakers_file.read_text())

        assert "segments" in data
        assert len(data["segments"]) > 0

        for segment in data["segments"]:
            assert "start" in segment
            assert "end" in segment
            assert "speaker" in segment
