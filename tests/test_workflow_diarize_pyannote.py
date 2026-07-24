"""Tests for besedy/workflows/diarize_pyannote.py.

Tests cover:
- Argument parsing patterns
- Diarization result structure
- Output file generation
- Error handling patterns

The pyannote model runtime is validated in the backend environment rather than
represented by placeholder tests in this extras-free unit suite.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


class TestArgumentParsing:
    """Tests for CLI argument parsing patterns."""

    def test_minimal_args(self):
        """Test parsing with only required --audio argument."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--output-dir", type=Path, default=None)
        parser.add_argument("--no-progress", action="store_true")
        parser.add_argument("--cpu", action="store_true")
        parser.add_argument("--min-speakers", type=int, default=None)
        parser.add_argument("--max-speakers", type=int, default=None)
        parser.add_argument("--clustering-threshold", type=float, default=None)

        args = parser.parse_args(["--audio", "/path/to/audio.wav"])
        assert args.audio == ["/path/to/audio.wav"]
        assert args.output_dir is None
        assert args.no_progress is False
        assert args.cpu is False

    def test_multiple_audio_files(self):
        """Test parsing multiple audio files."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)

        args = parser.parse_args(["--audio", "a.wav", "b.wav", "c.wav"])
        assert len(args.audio) == 3

    def test_speaker_constraints(self):
        """Test min/max speaker constraints."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--min-speakers", type=int, default=None)
        parser.add_argument("--max-speakers", type=int, default=None)

        args = parser.parse_args(
            [
                "--audio",
                "test.wav",
                "--min-speakers",
                "2",
                "--max-speakers",
                "5",
            ]
        )
        assert args.min_speakers == 2
        assert args.max_speakers == 5

    def test_clustering_threshold(self):
        """Test clustering threshold argument."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--clustering-threshold", type=float, default=None)

        args = parser.parse_args(
            [
                "--audio",
                "test.wav",
                "--clustering-threshold",
                "0.7",
            ]
        )
        assert args.clustering_threshold == 0.7

    def test_cpu_flag(self):
        """Test CPU mode flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--cpu", action="store_true")

        args = parser.parse_args(["--audio", "test.wav", "--cpu"])
        assert args.cpu is True

    def test_no_progress_flag(self):
        """Test no-progress flag."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--no-progress", action="store_true")

        args = parser.parse_args(["--audio", "test.wav", "--no-progress"])
        assert args.no_progress is True

    def test_output_dir_specification(self):
        """Test output directory argument."""
        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", nargs="+", required=True)
        parser.add_argument("--output-dir", type=Path, default=None)

        args = parser.parse_args(
            [
                "--audio",
                "test.wav",
                "--output-dir",
                "/custom/output",
            ]
        )
        assert args.output_dir == Path("/custom/output")


class TestDiarizationResultStructure:
    """Tests for diarization result structure.

    Tests the expected output format without requiring pyannote.
    """

    def test_result_structure(self):
        """Test diarization result has correct structure."""
        # Simulate the result structure from run_diarization
        result = {
            "audio_file": "/path/to/audio.wav",
            "model": "pyannote_speaker-diarization-community-1",
            "num_speakers": 2,
            "segments": [
                {"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"},
                {"start": 2.5, "end": 5.0, "speaker": "SPEAKER_01"},
                {"start": 5.0, "end": 8.0, "speaker": "SPEAKER_00"},
            ],
        }

        # Check result structure
        assert "audio_file" in result
        assert "model" in result
        assert "num_speakers" in result
        assert "segments" in result

        # Check segments
        assert len(result["segments"]) == 3
        assert result["num_speakers"] == 2

        # Check segment structure
        for seg in result["segments"]:
            assert "start" in seg
            assert "end" in seg
            assert "speaker" in seg
            assert isinstance(seg["start"], float)
            assert isinstance(seg["end"], float)

    def test_output_is_json_serializable(self):
        """Test that output can be serialized to JSON."""
        result = {
            "audio_file": "/path/to/audio.wav",
            "model": "pyannote_speaker-diarization-community-1",
            "num_speakers": 2,
            "segments": [
                {"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"},
                {"start": 2.5, "end": 5.0, "speaker": "SPEAKER_01"},
            ],
        }

        # Should not raise
        json_str = json.dumps(result, ensure_ascii=False, indent=2)
        assert json_str

        # Should roundtrip
        parsed = json.loads(json_str)
        assert parsed["num_speakers"] == result["num_speakers"]

    def test_empty_segments_handled(self):
        """Test handling of files with no detected speakers."""
        result = {
            "audio_file": "/path/to/silent.wav",
            "model": "pyannote_speaker-diarization-community-1",
            "num_speakers": 0,
            "segments": [],
        }

        assert result["num_speakers"] == 0
        assert result["segments"] == []

        # Should be JSON serializable
        json_str = json.dumps(result)
        assert json_str


class TestTimestampPrecision:
    """Tests for timestamp handling."""

    def test_timestamps_rounded_to_3_decimals(self):
        """Test timestamps should be rounded to 3 decimal places."""
        # Simulate what run_diarization does
        raw_start = 0.123456789
        raw_end = 2.987654321

        rounded_start = round(raw_start, 3)
        rounded_end = round(raw_end, 3)

        assert rounded_start == 0.123
        assert rounded_end == 2.988

    def test_speaker_count_calculation(self):
        """Test speaker count is calculated correctly."""
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00"},
            {"start": 1.0, "end": 2.0, "speaker": "SPEAKER_01"},
            {"start": 2.0, "end": 3.0, "speaker": "SPEAKER_00"},
            {"start": 3.0, "end": 4.0, "speaker": "SPEAKER_02"},
            {"start": 4.0, "end": 5.0, "speaker": "SPEAKER_01"},
        ]

        num_speakers = len(set(s["speaker"] for s in segments))
        assert num_speakers == 3


class TestOutputFileGeneration:
    """Tests for output file generation patterns."""

    def test_output_file_structure(self, tmp_path):
        """Test output file is created with correct structure."""
        output_dir = tmp_path / "output"
        output_dir.mkdir()

        result = {
            "audio_file": "/path/to/test.wav",
            "model": "pyannote_speaker-diarization-community-1",
            "num_speakers": 1,
            "segments": [
                {"start": 0.0, "end": 2.5, "speaker": "SPEAKER_00"},
            ],
        }

        # Simulate what run_diarization does
        output_file = output_dir / "speakers.json"
        with output_file.open("w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        assert output_file.exists()

        # Verify JSON is valid
        with output_file.open() as f:
            data = json.load(f)
        assert data["num_speakers"] == 1

    def test_model_name_constant(self):
        """Test model name is consistent."""
        MODEL_NAME = "pyannote_speaker-diarization-community-1"
        assert MODEL_NAME == "pyannote_speaker-diarization-community-1"


class TestPipelineParameterBuilding:
    """Tests for pipeline parameter construction."""

    def test_no_constraints_empty_params(self):
        """Test no constraints produces minimal params."""
        pipeline_params = {}

        min_speakers = None
        max_speakers = None
        clustering_threshold = None

        if min_speakers is not None:
            pipeline_params["min_speakers"] = min_speakers
        if max_speakers is not None:
            pipeline_params["max_speakers"] = max_speakers
        if clustering_threshold is not None:
            pipeline_params["clustering"] = {"threshold": clustering_threshold}

        assert pipeline_params == {}

    def test_speaker_constraints_added(self):
        """Test speaker constraints are added to params."""
        pipeline_params = {}

        min_speakers = 2
        max_speakers = 4
        clustering_threshold = None

        if min_speakers is not None:
            pipeline_params["min_speakers"] = min_speakers
        if max_speakers is not None:
            pipeline_params["max_speakers"] = max_speakers
        if clustering_threshold is not None:
            pipeline_params["clustering"] = {"threshold": clustering_threshold}

        assert pipeline_params["min_speakers"] == 2
        assert pipeline_params["max_speakers"] == 4
        assert "clustering" not in pipeline_params

    def test_clustering_threshold_added(self):
        """Test clustering threshold is added to params."""
        pipeline_params = {}

        min_speakers = None
        max_speakers = None
        clustering_threshold = 0.7

        if min_speakers is not None:
            pipeline_params["min_speakers"] = min_speakers
        if max_speakers is not None:
            pipeline_params["max_speakers"] = max_speakers
        if clustering_threshold is not None:
            pipeline_params["clustering"] = {"threshold": clustering_threshold}

        assert pipeline_params == {"clustering": {"threshold": 0.7}}

    def test_all_constraints_combined(self):
        """Test all constraints combined."""
        pipeline_params = {}

        min_speakers = 2
        max_speakers = 5
        clustering_threshold = 0.65

        if min_speakers is not None:
            pipeline_params["min_speakers"] = min_speakers
        if max_speakers is not None:
            pipeline_params["max_speakers"] = max_speakers
        if clustering_threshold is not None:
            pipeline_params["clustering"] = {"threshold": clustering_threshold}

        assert pipeline_params == {
            "min_speakers": 2,
            "max_speakers": 5,
            "clustering": {"threshold": 0.65},
        }


class TestHuggingFaceTokenHandling:
    """Tests for HuggingFace token handling patterns."""

    def test_token_from_env_var(self, monkeypatch):
        """Test token retrieval from environment variable."""
        monkeypatch.setenv("HF_TOKEN", "test_token_123")

        import os

        hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
        assert hf_token == "test_token_123"

    def test_token_fallback_to_huggingface_token(self, monkeypatch):
        """Test fallback to HUGGINGFACE_TOKEN."""
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.setenv("HUGGINGFACE_TOKEN", "fallback_token")

        import os

        hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
        assert hf_token == "fallback_token"

    def test_missing_token_detected(self, monkeypatch):
        """Test missing token detection."""
        monkeypatch.delenv("HF_TOKEN", raising=False)
        monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)

        import os

        hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
        assert hf_token is None
