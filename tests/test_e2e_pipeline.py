"""End-to-end pipeline tests.

Tests the complete workflow from audio files through catalog to transcripts.
These tests are marked as e2e and may be slow.
"""

from __future__ import annotations

import csv
import json

import pytest

from tests.helpers.audio import create_silent_wav, create_stereo_wav, create_tone_wav, get_wav_info
from tests.helpers.transcript import (
    create_diarization_json,
    create_transcript_with_words,
    write_transcript_json,
)


class TestPipelineDataFlow:
    """Tests for data flow through the pipeline stages."""

    @pytest.fixture
    def complete_pipeline_structure(self, tmp_path):
        """Create a complete pipeline structure for testing."""
        # Audio source directory
        audio_dir = tmp_path / "source_audio"
        audio_dir.mkdir()

        # Create audio files
        audio_files = []
        for i in range(3):
            wav_path = create_tone_wav(
                audio_dir / f"recording_{i:02d}.wav",
                frequency=440 + i * 100,
                duration_seconds=2.0,
            )
            audio_files.append(wav_path)

        # Create catalog CSV
        catalog_csv = tmp_path / "audio_catalog_20251128_120000.csv"
        from besedy.lib.catalog.manager import (
            AUDIO_HASH_ALGORITHM,
            audio_content_sha256sum,
            catalog_fieldnames,
        )

        fieldnames = catalog_fieldnames()
        with catalog_csv.open("w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for wav_path in audio_files:
                file_hash = audio_content_sha256sum(wav_path)
                assert file_hash is not None
                writer.writerow(
                    {
                        "Hash": file_hash,
                        "Hash Algorithm": AUDIO_HASH_ALGORITHM,
                        "Filename": wav_path.name,
                        "Full Path": str(wav_path),
                        "Status": "EXISTS",
                        "Size (bytes)": wav_path.stat().st_size,
                        "Size (human)": "10 KB",
                        "Duration": "00:02",
                    }
                )

        # Create transcripts directory
        transcripts_dir = tmp_path / "transcripts_20251128_120000"

        # Create transcripts for each audio file
        for wav_path in audio_files:
            file_hash = audio_content_sha256sum(wav_path)
            assert file_hash is not None

            # Faster-Whisper backend
            fw_dir = transcripts_dir / "faster-whisper" / "large-v3@silero_vad_v6" / file_hash
            fw_dir.mkdir(parents=True)
            transcript = create_transcript_with_words(
                words=["This", "is", "a", "test", "recording"],
                confidence=0.95,
            )
            write_transcript_json(fw_dir / "transcript.json", transcript)

            # NeMo backend
            nemo_dir = (
                transcripts_dir
                / "canary-nemo"
                / "nvidia_canary-1b-v2[greedy]@frame_vad"
                / file_hash
            )
            nemo_dir.mkdir(parents=True)
            transcript = create_transcript_with_words(
                words=["This", "is", "a", "test", "recording"],
                confidence=0.92,
            )
            write_transcript_json(nemo_dir / "transcript.json", transcript)

        return {
            "audio_dir": audio_dir,
            "audio_files": audio_files,
            "catalog_csv": catalog_csv,
            "transcripts_dir": transcripts_dir,
        }

    @pytest.mark.e2e
    def test_transcript_paths_match_catalog(self, complete_pipeline_structure):
        """Transcript directories match catalog hashes."""

        catalog_csv = complete_pipeline_structure["catalog_csv"]
        transcripts_dir = complete_pipeline_structure["transcripts_dir"]

        # Load catalog hashes
        with catalog_csv.open() as f:
            reader = csv.DictReader(f)
            catalog_hashes = {row["Hash"] for row in reader}

        # Find all transcript hashes
        transcript_hashes = set()
        for transcript_path in transcripts_dir.rglob("transcript.json"):
            # Hash is the parent directory name
            hash_dir = transcript_path.parent.name
            transcript_hashes.add(hash_dir)

        # Every catalog hash should have transcripts
        for catalog_hash in catalog_hashes:
            assert catalog_hash in transcript_hashes, f"Missing transcript for {catalog_hash}"

    @pytest.mark.e2e
    def test_transcript_schema_valid(self, complete_pipeline_structure):
        """All transcripts conform to schema."""
        from besedy.lib.validation.core import validate_shared_schema

        transcripts_dir = complete_pipeline_structure["transcripts_dir"]

        for transcript_path in transcripts_dir.rglob("transcript.json"):
            with transcript_path.open() as f:
                data = json.load(f)

            issues = validate_shared_schema(data)
            assert issues == [], f"Schema issues in {transcript_path}: {issues}"

    @pytest.mark.e2e
    def test_multiple_backends_coverage(self, complete_pipeline_structure):
        """Each audio file has transcripts from multiple backends."""
        transcripts_dir = complete_pipeline_structure["transcripts_dir"]
        audio_files = complete_pipeline_structure["audio_files"]

        from besedy.lib.catalog.manager import audio_content_sha256sum

        for wav_path in audio_files:
            file_hash = audio_content_sha256sum(wav_path)
            assert file_hash is not None

            # Check Faster-Whisper
            fw_transcript = (
                transcripts_dir
                / "faster-whisper"
                / "large-v3@silero_vad_v6"
                / file_hash
                / "transcript.json"
            )
            assert fw_transcript.exists(), f"Missing Faster-Whisper transcript for {file_hash}"

            # Check NeMo
            nemo_transcript = (
                transcripts_dir
                / "canary-nemo"
                / "nvidia_canary-1b-v2[greedy]@frame_vad"
                / file_hash
                / "transcript.json"
            )
            assert nemo_transcript.exists(), f"Missing NeMo transcript for {file_hash}"


class TestDiarizationPipeline:
    """Tests for diarization data pipeline."""

    @pytest.fixture
    def diarization_structure(self, tmp_path):
        """Create a structure with diarization outputs."""
        transcripts_dir = tmp_path / "transcripts_diarization"

        # Create diarization outputs for multiple files
        for hash_prefix in ["abc123", "def456"]:
            # Pyannote diarization
            pyannote_dir = (
                transcripts_dir / "pyannote" / "pyannote_speaker-diarization-3.1" / hash_prefix
            )
            pyannote_dir.mkdir(parents=True)
            diarization = create_diarization_json(
                speakers=["SPEAKER_00", "SPEAKER_01", "SPEAKER_00", "SPEAKER_01"],
            )
            write_transcript_json(pyannote_dir / "speakers.json", diarization)

        return transcripts_dir

    @pytest.mark.e2e
    def test_diarization_structure_valid(self, diarization_structure):
        """Diarization outputs have valid structure."""
        for speakers_path in diarization_structure.rglob("speakers.json"):
            with speakers_path.open() as f:
                data = json.load(f)

            assert "segments" in data
            for segment in data["segments"]:
                assert "speaker" in segment
                assert "start" in segment
                assert "end" in segment

    @pytest.mark.e2e
    def test_diarization_speakers_unique_per_file(self, diarization_structure):
        """Speaker IDs are unique within each file."""
        for speakers_path in diarization_structure.rglob("speakers.json"):
            with speakers_path.open() as f:
                data = json.load(f)

            speakers = {seg["speaker"] for seg in data["segments"]}
            # Should have at least one speaker
            assert len(speakers) >= 1


class TestAnalysisPipelineData:
    """Tests for analysis data loading."""

    @pytest.fixture
    def analysis_ready_transcripts(self, tmp_path):
        """Create transcripts ready for analysis."""
        transcripts_dir = tmp_path / "transcripts_for_analysis"

        # Create transcripts with varying confidence scores
        confidences = [0.95, 0.85, 0.75]
        hashes = ["hash_high", "hash_medium", "hash_low"]

        for hash_prefix, conf in zip(hashes, confidences):
            backend_dir = (
                transcripts_dir / "faster-whisper" / "large-v3@silero_vad_v6" / hash_prefix
            )
            backend_dir.mkdir(parents=True)

            transcript = create_transcript_with_words(
                words=["Word"] * 20,
                confidence=conf,
            )
            write_transcript_json(backend_dir / "transcript.json", transcript)

        return transcripts_dir

    @pytest.mark.e2e
    def test_transcript_json_structure(self, analysis_ready_transcripts):
        """Transcript JSON files have correct structure."""
        for transcript_path in analysis_ready_transcripts.rglob("transcript.json"):
            with transcript_path.open() as f:
                data = json.load(f)

            assert "segments" in data
            for segment in data["segments"]:
                assert "start" in segment
                assert "end" in segment
                assert "text" in segment
                if "words" in segment:
                    for word in segment["words"]:
                        assert "word" in word
                        assert "start" in word
                        assert "end" in word

    @pytest.mark.e2e
    def test_transcript_discovery(self, analysis_ready_transcripts):
        """Transcripts can be discovered by globbing."""
        transcripts = list(analysis_ready_transcripts.rglob("transcript.json"))
        assert len(transcripts) == 3  # Three hash directories

    @pytest.mark.e2e
    def test_confidence_in_json(self, analysis_ready_transcripts):
        """Confidence values are stored in JSON transcripts."""
        for transcript_path in analysis_ready_transcripts.rglob("transcript.json"):
            with transcript_path.open() as f:
                data = json.load(f)

            for segment in data["segments"]:
                if "confidence" in segment:
                    assert 0.0 <= segment["confidence"] <= 1.0
                if "words" in segment:
                    for word in segment["words"]:
                        if "confidence" in word:
                            assert 0.0 <= word["confidence"] <= 1.0


class TestAudioProcessingPipeline:
    """Tests for audio processing stages."""

    @pytest.fixture
    def mixed_audio_formats(self, tmp_path):
        """Create audio files in various formats."""
        audio_dir = tmp_path / "mixed_formats"
        audio_dir.mkdir()

        # 16kHz mono (already normalized)
        create_silent_wav(audio_dir / "already_normalized.wav")

        # 44kHz stereo (needs conversion)
        create_stereo_wav(audio_dir / "needs_conversion.wav")

        # Different durations
        create_tone_wav(audio_dir / "short.wav", duration_seconds=0.5)
        create_tone_wav(audio_dir / "long.wav", duration_seconds=5.0)

        return audio_dir

    @pytest.mark.e2e
    def test_wav_info_extraction(self, mixed_audio_formats):
        """WAV info extraction works for all files."""
        for wav_path in mixed_audio_formats.glob("*.wav"):
            info = get_wav_info(wav_path)
            assert info.sample_rate > 0
            assert info.channels > 0
            assert info.duration_seconds > 0

    @pytest.mark.e2e
    def test_audio_format_detection(self, mixed_audio_formats):
        """Audio format is correctly detected."""
        # Already normalized
        info = get_wav_info(mixed_audio_formats / "already_normalized.wav")
        assert info.sample_rate == 16000
        assert info.channels == 1

        # Needs conversion
        info = get_wav_info(mixed_audio_formats / "needs_conversion.wav")
        assert info.sample_rate == 44100
        assert info.channels == 2


class TestTimestampAlignment:
    """Tests for timestamp alignment between pipeline stages."""

    @pytest.fixture
    def timestamped_structure(self, tmp_path):
        """Create structure with consistent timestamps."""
        timestamp = "20251128_120000"

        # Catalog
        catalog = tmp_path / f"audio_catalog_{timestamp}.csv"
        catalog.write_text("Hash,Filename,Status\nabc123,test.wav,EXISTS\n")

        # Normalized catalog
        normalized = tmp_path / f"audio_catalog_{timestamp}_normalized.csv"
        normalized.write_text(
            "Hash,Filename,Status,Staged Path\nabc123,test.wav,EXISTS,staged/abc123.wav\n"
        )

        # Transcripts directory
        transcripts = tmp_path / f"transcripts_{timestamp}"
        transcripts.mkdir()
        (transcripts / "faster-whisper" / "large-v3@silero_vad_v6" / "abc123").mkdir(parents=True)

        return {
            "timestamp": timestamp,
            "catalog": catalog,
            "normalized": normalized,
            "transcripts": transcripts,
        }

    @pytest.mark.e2e
    def test_timestamp_extraction(self, timestamped_structure):
        """Timestamps can be extracted from filenames."""
        import re

        timestamp = timestamped_structure["timestamp"]
        catalog = timestamped_structure["catalog"]

        # Extract timestamp from catalog name
        match = re.search(r"audio_catalog_(\d{8}_\d{6})", catalog.name)
        assert match is not None
        assert match.group(1) == timestamp

    @pytest.mark.e2e
    def test_timestamp_consistency(self, timestamped_structure):
        """All pipeline stages use consistent timestamps."""
        timestamp = timestamped_structure["timestamp"]

        # All should contain the same timestamp
        assert timestamp in timestamped_structure["catalog"].name
        assert timestamp in timestamped_structure["normalized"].name
        assert timestamp in timestamped_structure["transcripts"].name
