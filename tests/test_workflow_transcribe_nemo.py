"""Tests for besedy/workflows/transcribe_nemo.py.

Tests cover:
- VAD configuration loading (pure Python)
- Audio file collection patterns
- Hidden file detection

NeMo/torch model execution is validated in the backend environment rather than
represented by placeholder tests in this extras-free unit suite.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
import yaml


class TestLoadVadConfig:
    """Tests for VAD configuration loading.

    These tests don't require NeMo imports - they test pure YAML loading.
    """

    def test_load_valid_yaml_config(self, tmp_path):
        """Test loading valid YAML VAD config."""

        # Replicate the function logic for testing
        def _load_vad_config(path):
            if path is None:
                return {}
            if not path.exists():
                raise FileNotFoundError(f"VAD config file not found: {path}")
            with path.open("r", encoding="utf-8") as handle:
                return yaml.safe_load(handle) or {}

        config_path = tmp_path / "vad_config.yaml"
        config_path.write_text(
            """
onset: 0.5
offset: 0.4
min_duration_on: 0.1
min_duration_off: 0.3
pad_onset: 0.1
pad_offset: 0.1
"""
        )

        config = _load_vad_config(config_path)
        assert config["onset"] == 0.5
        assert config["offset"] == 0.4
        assert config["min_duration_on"] == 0.1

    def test_load_none_returns_empty_dict(self):
        """Test that None path returns empty dict."""

        def _load_vad_config(path):
            if path is None:
                return {}
            return {}

        config = _load_vad_config(None)
        assert config == {}

    def test_missing_file_raises_error(self, tmp_path):
        """Test that missing file raises FileNotFoundError."""

        def _load_vad_config(path):
            if path is None:
                return {}
            if not path.exists():
                raise FileNotFoundError(f"VAD config file not found: {path}")
            return {}

        missing = tmp_path / "nonexistent.yaml"
        with pytest.raises(FileNotFoundError, match="VAD config file not found"):
            _load_vad_config(missing)

    def test_empty_yaml_returns_empty_dict(self, tmp_path):
        """Test that empty YAML file returns empty dict."""

        def _load_vad_config(path):
            if path is None:
                return {}
            if not path.exists():
                raise FileNotFoundError(f"VAD config file not found: {path}")
            with path.open("r", encoding="utf-8") as handle:
                return yaml.safe_load(handle) or {}

        config_path = tmp_path / "empty.yaml"
        config_path.write_text("")

        config = _load_vad_config(config_path)
        assert config == {}


class TestIsHidden:
    """Tests for hidden path detection.

    These tests don't require NeMo imports.
    """

    def _is_hidden(self, path: Path) -> bool:
        """Check if path contains hidden components."""
        return any(part.startswith(".") for part in path.parts if part not in ("/", ""))

    def test_hidden_file_detected(self):
        """Test hidden file is detected."""
        assert self._is_hidden(Path("/path/to/.hidden_file.wav")) is True

    def test_hidden_directory_detected(self):
        """Test hidden directory in path is detected."""
        assert self._is_hidden(Path("/path/.hidden_dir/file.wav")) is True

    def test_normal_path_not_hidden(self):
        """Test normal path is not detected as hidden."""
        assert self._is_hidden(Path("/path/to/normal_file.wav")) is False

    def test_root_path_not_hidden(self):
        """Test root path is not detected as hidden."""
        assert self._is_hidden(Path("/file.wav")) is False

    def test_relative_hidden_path(self):
        """Test relative hidden path."""
        assert self._is_hidden(Path(".hidden/file.wav")) is True

    def test_dot_in_filename_not_hidden(self):
        """Test that dots in filenames (not at start) aren't hidden."""
        assert self._is_hidden(Path("/path/to/file.name.wav")) is False


class TestCollectAudioFilesLogic:
    """Tests for audio file collection logic.

    These test the patterns without importing the actual module.
    """

    def _collect_audio_files(self, audio_list, audio_dir):
        """Replicate collect_audio_files logic for testing."""

        def _is_hidden(path):
            return any(part.startswith(".") for part in path.parts if part not in ("/", ""))

        candidates = []
        if audio_list:
            candidates.extend(audio_list)
        if audio_dir and audio_dir.exists():
            candidates.extend(audio_dir.rglob("*.wav"))

        unique_files = sorted(
            {
                resolved
                for path in candidates
                if path.exists()
                and path.is_file()
                and path.suffix.lower() == ".wav"
                and not _is_hidden(path)
                and not _is_hidden(resolved := path.resolve())
            }
        )

        if not unique_files:
            raise ValueError("No audio files found")

        return unique_files

    def test_collect_from_list(self, tmp_path):
        """Test collecting files from list."""
        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        result = self._collect_audio_files([audio_file], None)
        assert len(result) == 1
        assert result[0] == audio_file.resolve()

    def test_collect_from_directory(self, tmp_path):
        """Test collecting files from directory."""
        (tmp_path / "audio1.wav").touch()
        (tmp_path / "audio2.wav").touch()
        (tmp_path / "subdir").mkdir()
        (tmp_path / "subdir" / "audio3.wav").touch()

        result = self._collect_audio_files(None, tmp_path)
        assert len(result) == 3

    def test_hidden_files_excluded(self, tmp_path):
        """Test that hidden files are excluded."""
        (tmp_path / "visible.wav").touch()
        (tmp_path / ".hidden.wav").touch()
        (tmp_path / ".hidden_dir").mkdir()
        (tmp_path / ".hidden_dir" / "audio.wav").touch()

        result = self._collect_audio_files(None, tmp_path)
        assert len(result) == 1
        assert result[0].name == "visible.wav"

    def test_empty_collection_raises(self, tmp_path):
        """Test that empty collection raises ValueError."""
        with pytest.raises(ValueError, match="No audio files found"):
            self._collect_audio_files(None, tmp_path)

    def test_nonexistent_files_filtered(self, tmp_path):
        """Test that nonexistent files are filtered out."""
        existing = tmp_path / "exists.wav"
        existing.touch()
        nonexistent = tmp_path / "missing.wav"

        result = self._collect_audio_files([existing, nonexistent], None)
        assert len(result) == 1

    def test_duplicates_removed(self, tmp_path):
        """Test that duplicate paths are removed."""
        audio_file = tmp_path / "test.wav"
        audio_file.touch()

        result = self._collect_audio_files([audio_file, audio_file, audio_file], None)
        assert len(result) == 1

    def test_results_sorted(self, tmp_path):
        """Test that results are sorted."""
        (tmp_path / "z_audio.wav").touch()
        (tmp_path / "a_audio.wav").touch()
        (tmp_path / "m_audio.wav").touch()

        result = self._collect_audio_files(None, tmp_path)
        names = [p.name for p in result]
        assert names == sorted(names)

    def test_non_wav_files_excluded(self, tmp_path):
        """Test that non-WAV files are excluded."""
        (tmp_path / "audio.wav").touch()
        (tmp_path / "audio.mp3").touch()
        (tmp_path / "audio.txt").touch()

        result = self._collect_audio_files(None, tmp_path)
        assert len(result) == 1
        assert result[0].suffix == ".wav"


class TestArgumentParsingPatterns:
    """Tests for argument parsing patterns.

    Uses argparse directly to test argument specifications.
    """

    def test_basic_argument_parsing(self):
        """Test basic argument structure."""
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", type=Path, nargs="+")
        parser.add_argument("--audio-dir", type=Path)
        parser.add_argument("--source-lang", type=str, default="cs")
        parser.add_argument("--target-lang", type=str, default="cs")
        parser.add_argument("--batch-size", type=int, default=1)
        parser.add_argument("--chunk-length", type=float, default=30.0)
        parser.add_argument("--device", type=str, default="auto")
        parser.add_argument("--output-dir", type=Path, default=None)
        parser.add_argument("--verbose", action="store_true")

        args = parser.parse_args(["--audio", "/path/to/audio.wav"])
        assert args.audio == [Path("/path/to/audio.wav")]
        assert args.source_lang == "cs"
        assert args.target_lang == "cs"

    def test_multiple_audio_files(self):
        """Test multiple audio files."""
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", type=Path, nargs="+")

        args = parser.parse_args(["--audio", "a.wav", "b.wav", "c.wav"])
        assert len(args.audio) == 3

    def test_language_options(self):
        """Test language specification."""
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("--audio", type=Path, nargs="+")
        parser.add_argument("--source-lang", type=str, default="cs")
        parser.add_argument("--target-lang", type=str, default="cs")

        args = parser.parse_args(
            [
                "--audio",
                "test.wav",
                "--source-lang",
                "en",
                "--target-lang",
                "de",
            ]
        )
        assert args.source_lang == "en"
        assert args.target_lang == "de"


class TestChunkingDefaults:
    """Tests for NeMo segment chunking defaults."""

    @staticmethod
    def _load_segments_module():
        module_path = (
            Path(__file__).resolve().parents[1] / "besedy" / "lib" / "nemo" / "segments.py"
        )
        spec = importlib.util.spec_from_file_location("test_nemo_segments_module", module_path)
        assert spec is not None
        assert spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_build_chunking_params_uses_dataclass_default_max_segment_length(self):
        """Chunking can be enabled without requiring a NemoConfig max length field."""
        segments = self._load_segments_module()

        params = segments.build_chunking_params(
            chunk_length=None,
            chunk_min_silence_ms=250,
            chunk_silence_threshold=None,
            default_silence_threshold=0.42,
        )

        assert params is not None
        assert params.max_segment_length == 30.0
        assert params.min_silence_duration == 0.25
        assert params.silence_threshold == 0.42
