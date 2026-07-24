"""Unit tests for audio extension detection in audio_catalog.py."""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from besedy.lib.catalog.manager import (
    collect_input_files,
    get_supported_audio_extensions,
    is_audio_file,
)


class TestGetSupportedAudioExtensions:
    """Tests for get_supported_audio_extensions function."""

    def test_returns_set_of_strings(self):
        """Should return a set of lowercase string extensions."""
        result = get_supported_audio_extensions()
        assert isinstance(result, set)
        assert all(isinstance(ext, str) for ext in result)
        assert all(ext.islower() for ext in result)
        assert all(not ext.startswith(".") for ext in result)

    def test_includes_common_audio_formats(self):
        """Should include common audio formats like mp3, wav, flac."""
        result = get_supported_audio_extensions()
        common_formats = {"mp3", "wav", "flac", "ogg", "m4a", "aac"}
        assert common_formats.issubset(result), f"Missing formats: {common_formats - result}"

    def test_with_real_ffmpeg(self):
        """Should successfully query real ffmpeg if available."""
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=5)
            has_ffmpeg = True
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            has_ffmpeg = False

        if has_ffmpeg:
            result = get_supported_audio_extensions("ffmpeg")
            assert len(result) >= 20, "Should detect at least 20 audio formats"
            assert "mp3" in result
            assert "wav" in result
        else:
            pytest.skip("ffmpeg not available")

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_error_when_ffmpeg_missing(self, mock_run):
        """Should raise when ffmpeg cannot be executed."""
        mock_run.side_effect = FileNotFoundError("ffmpeg not found")

        with pytest.raises(RuntimeError):
            get_supported_audio_extensions("nonexistent_ffmpeg")

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_timeout_raises_runtime_error(self, mock_run):
        """Timeouts from ffmpeg should propagate as RuntimeError."""
        mock_run.side_effect = subprocess.TimeoutExpired("ffmpeg", 5)

        with pytest.raises(RuntimeError):
            get_supported_audio_extensions()

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_error_exit_raises_runtime_error(self, mock_run):
        """Non-zero ffmpeg exit should raise RuntimeError."""
        mock_run.side_effect = subprocess.CalledProcessError(1, "ffmpeg")

        with pytest.raises(RuntimeError):
            get_supported_audio_extensions()

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_parses_ffmpeg_demuxers_output(self, mock_run):
        """Should correctly parse ffmpeg -demuxers output."""
        mock_result = MagicMock()
        mock_result.stdout = """File formats:
 D. = Demuxing supported
 --
 D   aac             raw ADTS AAC (Advanced Audio Coding)
 D   ac3             raw AC-3
 D   aiff            Audio IFF
 D   flac            raw FLAC
 D   mp3             MP2/3 (MPEG audio layer 2/3)
 D   ogg             Ogg
 D   wav             WAV / WAVE (Waveform Audio)
 D   matroska,webm   Matroska / WebM
 D   mov,mp4,m4a     QuickTime / MOV
"""
        mock_run.return_value = mock_result

        result = get_supported_audio_extensions()

        assert "mp3" in result
        assert "wav" in result
        assert "flac" in result
        assert "ogg" in result
        assert "aac" in result
        assert "m4a" in result
        assert "webm" in result

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_handles_empty_output(self, mock_run):
        """Empty -demuxers output should raise RuntimeError."""
        mock_result = MagicMock()
        mock_result.stdout = ""
        mock_run.return_value = mock_result

        with pytest.raises(RuntimeError):
            get_supported_audio_extensions()

    @patch("besedy.lib.catalog.manager.subprocess.run")
    def test_handles_malformed_output(self, mock_run):
        """Malformed -demuxers output should raise RuntimeError."""
        mock_result = MagicMock()
        mock_result.stdout = "Some random text\nNot proper format\n"
        mock_run.return_value = mock_result

        with pytest.raises(RuntimeError):
            get_supported_audio_extensions()


class TestIsAudioFile:
    """Tests for is_audio_file function."""

    def test_returns_true_for_matching_extension(self):
        """Should return True when file extension matches supported formats."""
        supported = {"mp3", "wav", "flac"}

        assert is_audio_file(Path("song.mp3"), supported) is True
        assert is_audio_file(Path("audio.wav"), supported) is True
        assert is_audio_file(Path("music.flac"), supported) is True

    def test_returns_false_for_non_matching_extension(self):
        """Should return False when file extension doesn't match."""
        supported = {"mp3", "wav", "flac"}

        assert is_audio_file(Path("document.pdf"), supported) is False
        assert is_audio_file(Path("image.jpg"), supported) is False
        assert is_audio_file(Path("video.mp4"), supported) is False

    def test_case_insensitive_matching(self):
        """Should match extensions case-insensitively."""
        supported = {"mp3", "wav"}

        assert is_audio_file(Path("song.MP3"), supported) is True
        assert is_audio_file(Path("audio.WAV"), supported) is True
        assert is_audio_file(Path("music.Mp3"), supported) is True

    def test_handles_files_without_extension(self):
        """Should handle files without extensions gracefully."""
        supported = {"mp3", "wav"}

        assert is_audio_file(Path("README"), supported) is False
        assert is_audio_file(Path("Makefile"), supported) is False

    def test_handles_multiple_dots_in_filename(self):
        """Should only check the final extension."""
        supported = {"mp3", "wav"}

        assert is_audio_file(Path("my.song.name.mp3"), supported) is True
        assert is_audio_file(Path("file.backup.tar.gz"), supported) is False

    def test_returns_true_when_no_filter_provided(self):
        """Should return True for all files when filter is empty."""
        empty_filter: set[str] = set()

        assert is_audio_file(Path("anything.mp3"), empty_filter) is True
        assert is_audio_file(Path("document.pdf"), empty_filter) is True
        assert is_audio_file(Path("image.jpg"), empty_filter) is True

    def test_handles_hidden_files(self):
        """Should check extension regardless of hidden status."""
        supported = {"mp3"}

        assert is_audio_file(Path(".hidden.mp3"), supported) is True
        assert is_audio_file(Path(".hidden.pdf"), supported) is False


class TestCollectInputFilesWithFilter:
    """Tests for collect_input_files function with extension filtering."""

    def test_collects_only_audio_files_with_filter(self, tmp_path):
        """Should only collect files matching the audio filter."""
        # Create test files
        (tmp_path / "audio1.mp3").touch()
        (tmp_path / "audio2.wav").touch()
        (tmp_path / "document.pdf").touch()
        (tmp_path / "image.jpg").touch()

        supported = {"mp3", "wav"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        filenames = {f.name for f in files}
        assert filenames == {"audio1.mp3", "audio2.wav"}
        assert len(warnings) == 0

    def test_collects_all_files_without_filter(self, tmp_path):
        """Should collect all files when no filter is provided."""
        # Create test files
        (tmp_path / "audio.mp3").touch()
        (tmp_path / "document.pdf").touch()
        (tmp_path / "image.jpg").touch()

        files, warnings = collect_input_files([tmp_path], supported_extensions=None)

        assert len(files) == 3

    def test_filters_in_subdirectories(self, tmp_path):
        """Should apply filter recursively in subdirectories."""
        # Create subdirectories with files
        subdir1 = tmp_path / "sub1"
        subdir2 = tmp_path / "sub2"
        subdir1.mkdir()
        subdir2.mkdir()

        (tmp_path / "root.mp3").touch()
        (subdir1 / "audio1.flac").touch()
        (subdir1 / "readme.txt").touch()
        (subdir2 / "audio2.ogg").touch()
        (subdir2 / "image.png").touch()

        supported = {"mp3", "flac", "ogg"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        filenames = {f.name for f in files}
        assert filenames == {"root.mp3", "audio1.flac", "audio2.ogg"}

    def test_respects_existing_skip_logic(self, tmp_path):
        """Should skip hidden files and canonical audio-hash sidecars."""
        (tmp_path / "audio.mp3").touch()
        (tmp_path / ".hidden.mp3").touch()  # Hidden file
        (tmp_path / "audio.mp3.audiohash").touch()  # Hash sidecar

        supported = {"mp3"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        filenames = {f.name for f in files}
        # Should only get the non-hidden audio source.
        assert filenames == {"audio.mp3"}

    def test_handles_direct_file_path_with_filter(self, tmp_path):
        """Should filter single file paths correctly."""
        audio_file = tmp_path / "song.mp3"
        non_audio_file = tmp_path / "doc.pdf"
        audio_file.touch()
        non_audio_file.touch()

        supported = {"mp3"}

        # Should include the audio file
        files, warnings = collect_input_files([audio_file], supported_extensions=supported)
        assert len(files) == 1
        assert files[0].name == "song.mp3"

        # Should exclude the non-audio file
        files, warnings = collect_input_files([non_audio_file], supported_extensions=supported)
        assert len(files) == 0

    def test_filter_empty_set_accepts_all(self, tmp_path):
        """Empty filter set should accept all files (same as None)."""
        (tmp_path / "audio.mp3").touch()
        (tmp_path / "document.pdf").touch()

        empty_filter: set[str] = set()
        files, warnings = collect_input_files([tmp_path], supported_extensions=empty_filter)

        # Empty set means no filter, so should collect all
        assert len(files) == 2


class TestIntegrationWithRealFFmpeg:
    """Integration tests using real ffmpeg if available."""

    @pytest.mark.integration
    def test_full_workflow_with_real_ffmpeg(self, tmp_path):
        """Test complete workflow with real ffmpeg detection."""
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=5)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            pytest.skip("ffmpeg not available")

        # Create test files
        (tmp_path / "audio.mp3").touch()
        (tmp_path / "audio.wav").touch()
        (tmp_path / "audio.flac").touch()
        (tmp_path / "document.pdf").touch()
        (tmp_path / "image.jpg").touch()
        (tmp_path / "video.mp4").touch()

        # Get real extensions from ffmpeg
        extensions = get_supported_audio_extensions("ffmpeg")

        # Collect files
        files, warnings = collect_input_files([tmp_path], supported_extensions=extensions)

        # Should have filtered to audio files only
        filenames = {f.name for f in files}

        # mp3, wav, flac should definitely be included
        assert "audio.mp3" in filenames
        assert "audio.wav" in filenames
        assert "audio.flac" in filenames

        # Non-audio should be excluded
        assert "document.pdf" not in filenames
        assert "image.jpg" not in filenames

        # Note: mp4 might be included if ffmpeg considers it an audio container
        # So we don't assert on it

    @pytest.mark.integration
    def test_detection_matches_ffmpeg_capabilities(self):
        """Detected extensions should match actual ffmpeg support."""
        try:
            subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=5)
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            pytest.skip("ffmpeg not available")

        extensions = get_supported_audio_extensions("ffmpeg")

        # Test that common formats are detected
        common = ["mp3", "wav", "flac", "ogg", "m4a"]
        for ext in common:
            assert ext in extensions, f"Common format {ext} not detected"


class TestEdgeCases:
    """Tests for edge cases and error conditions."""

    def test_symlinks_handled_correctly(self, tmp_path):
        """Should handle symlinks appropriately."""
        real_file = tmp_path / "real.mp3"
        real_file.touch()
        symlink = tmp_path / "link.mp3"
        symlink.symlink_to(real_file)

        supported = {"mp3"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        # Should collect files (might deduplicate based on resolved paths)
        assert len(files) >= 1
        filenames = {f.name for f in files}
        assert "real.mp3" in filenames or "link.mp3" in filenames

    def test_unicode_filenames(self, tmp_path):
        """Should handle unicode in filenames correctly."""
        (tmp_path / "čeština.mp3").touch()
        (tmp_path / "日本語.wav").touch()
        (tmp_path / "Москва.flac").touch()

        supported = {"mp3", "wav", "flac"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        assert len(files) == 3

    def test_very_long_extensions(self, tmp_path):
        """Should handle unusual extension lengths."""
        (tmp_path / "file.verylongextension").touch()

        supported = {"mp3"}
        files, warnings = collect_input_files([tmp_path], supported_extensions=supported)

        # Should not match
        assert len(files) == 0

    def test_no_extension_dot_handling(self, tmp_path):
        """Extensions in filter should not have leading dots."""
        (tmp_path / "audio.mp3").touch()

        # Filter should use "mp3" not ".mp3"
        wrong_filter = {".mp3"}  # Wrong format
        files, warnings = collect_input_files([tmp_path], supported_extensions=wrong_filter)
        assert len(files) == 0  # Won't match because of the dot

        correct_filter = {"mp3"}  # Correct format
        files, warnings = collect_input_files([tmp_path], supported_extensions=correct_filter)
        assert len(files) == 1
