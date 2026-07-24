"""Tests for test helper utilities."""

from __future__ import annotations

import json

import pytest

from tests.helpers.audio import (
    create_silent_wav,
    create_stereo_wav,
    create_tone_wav,
    get_wav_info,
)
from tests.helpers.transcript import (
    create_diarization_json,
    create_minimal_transcript,
    create_multi_segment_transcript,
    create_transcript_with_words,
    write_transcript_json,
)


class TestAudioHelpers:
    """Tests for audio generation helpers."""

    def test_create_silent_wav(self, tmp_path):
        """Silent WAV is created with correct properties."""
        wav_path = create_silent_wav(tmp_path / "silence.wav", duration_seconds=2.0)
        assert wav_path.exists()

        info = get_wav_info(wav_path)
        assert info.sample_rate == 16000
        assert info.channels == 1
        assert info.duration_seconds == pytest.approx(2.0, rel=0.01)

    def test_create_tone_wav(self, tmp_path):
        """Tone WAV is created with correct properties."""
        wav_path = create_tone_wav(
            tmp_path / "tone.wav",
            frequency=440.0,
            duration_seconds=1.5,
        )
        assert wav_path.exists()

        info = get_wav_info(wav_path)
        assert info.sample_rate == 16000
        assert info.channels == 1
        assert info.duration_seconds == pytest.approx(1.5, rel=0.01)

    def test_create_stereo_wav(self, tmp_path):
        """Stereo WAV is created with correct properties."""
        wav_path = create_stereo_wav(tmp_path / "stereo.wav", duration_seconds=1.0)
        assert wav_path.exists()

        info = get_wav_info(wav_path)
        assert info.sample_rate == 44100
        assert info.channels == 2

    def test_get_wav_info_returns_namedtuple(self, tmp_path):
        """get_wav_info returns a proper WavInfo."""
        wav_path = create_silent_wav(tmp_path / "test.wav")
        info = get_wav_info(wav_path)

        assert hasattr(info, "sample_rate")
        assert hasattr(info, "channels")
        assert hasattr(info, "duration_seconds")


class TestTranscriptHelpers:
    """Tests for transcript generation helpers."""

    def test_create_minimal_transcript(self):
        """Minimal transcript has required fields."""
        data = create_minimal_transcript(text="Hello", start=0.0, end=1.0)

        assert "segments" in data
        assert len(data["segments"]) == 1
        segment = data["segments"][0]
        assert segment["text"] == "Hello"
        assert segment["start"] == 0.0
        assert segment["end"] == 1.0

    def test_create_minimal_with_confidence(self):
        """Minimal transcript can include confidence."""
        data = create_minimal_transcript(confidence=0.95)
        assert data["segments"][0]["confidence"] == 0.95

    def test_create_transcript_with_words(self):
        """Word-level transcript has correct structure."""
        data = create_transcript_with_words(["Hello", "world"])

        segment = data["segments"][0]
        assert "words" in segment
        assert len(segment["words"]) == 2
        assert segment["words"][0]["word"] == "Hello"
        assert segment["words"][1]["word"] == "world"

    def test_create_multi_segment_transcript(self):
        """Multi-segment transcript has correct count."""
        data = create_multi_segment_transcript(["First", "Second", "Third"])

        assert len(data["segments"]) == 3
        assert data["segments"][0]["text"] == "First"
        assert data["segments"][2]["text"] == "Third"

    def test_create_diarization_json(self):
        """Diarization JSON has speaker fields."""
        data = create_diarization_json(["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"])

        assert len(data["segments"]) == 3
        assert data["segments"][0]["speaker"] == "SPEAKER_00"
        assert data["segments"][1]["speaker"] == "SPEAKER_01"

    def test_write_transcript_json(self, tmp_path):
        """Transcript can be written to file."""
        data = create_minimal_transcript()
        path = write_transcript_json(tmp_path / "transcript.json", data)

        assert path.exists()
        loaded = json.loads(path.read_text())
        assert loaded == data

    def test_write_creates_parent_dirs(self, tmp_path):
        """Write creates parent directories if needed."""
        data = create_minimal_transcript()
        path = write_transcript_json(
            tmp_path / "nested" / "dir" / "transcript.json",
            data,
        )
        assert path.exists()


class TestConfTestFixtures:
    """Tests verifying conftest fixtures work."""

    def test_wav_16k_mono_fixture(self, wav_16k_mono):
        """wav_16k_mono fixture creates valid file."""
        assert wav_16k_mono.exists()
        info = get_wav_info(wav_16k_mono)
        assert info.sample_rate == 16000
        assert info.channels == 1

    def test_wav_44k_stereo_fixture(self, wav_44k_stereo):
        """wav_44k_stereo fixture creates valid file."""
        assert wav_44k_stereo.exists()
        info = get_wav_info(wav_44k_stereo)
        assert info.sample_rate == 44100
        assert info.channels == 2

    def test_mock_transcripts_dir_fixture(self, mock_transcripts_dir):
        """mock_transcripts_dir fixture creates structure."""
        assert mock_transcripts_dir.exists()
        # Should have transcript.json files
        transcripts = list(mock_transcripts_dir.rglob("transcript.json"))
        assert len(transcripts) >= 1

    def test_sample_audio_catalog_csv_fixture(self, sample_audio_catalog_csv):
        """sample_audio_catalog_csv fixture creates valid CSV."""
        assert sample_audio_catalog_csv.exists()

        import csv

        with sample_audio_catalog_csv.open() as f:
            reader = csv.DictReader(f)
            rows = list(reader)

        assert len(rows) == 2
        assert "Hash" in reader.fieldnames
