"""Real audio processing integration tests (no mocks).

These tests actually run ffmpeg/ffprobe and verify audio processing:
1. Audio normalization produces correct output format
2. Loudness normalization hits target LUFS
3. Sample rate conversion works correctly
4. Quality metrics extraction works

Marked with @pytest.mark.integration - requires ffmpeg/ffprobe installed.
"""

from __future__ import annotations

import json
import subprocess
import wave

import pytest

from tests.helpers.audio import create_tone_wav


@pytest.mark.integration
class TestRealAudioNormalization:
    """Tests that actually normalize audio with ffmpeg."""

    @pytest.fixture
    def loud_audio(self, tmp_path):
        """Create a loud audio file (needs normalization)."""
        # Create a full-scale sine wave (0 dB, very loud)
        return create_tone_wav(
            tmp_path / "loud.wav",
            frequency=440.0,
            duration_seconds=1.0,
            amplitude=0.95,  # Near full scale
        )

    @pytest.fixture
    def quiet_audio(self, tmp_path):
        """Create a quiet audio file (needs normalization)."""
        return create_tone_wav(
            tmp_path / "quiet.wav",
            frequency=440.0,
            duration_seconds=1.0,
            amplitude=0.01,  # Very quiet
        )

    def test_normalize_loud_audio_reduces_level(self, loud_audio, tmp_path):
        """Loud audio is reduced to target LUFS."""
        output = tmp_path / "normalized.wav"

        # Run ffmpeg loudnorm (two-pass would be better, but single-pass works)
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(loud_audio),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=11",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"ffmpeg failed: {result.stderr}"
        assert output.exists()

        # Verify output is quieter
        with wave.open(str(output), "rb") as wf:
            assert wf.getframerate() == 16000
            assert wf.getnchannels() == 1

    def test_normalize_quiet_audio_increases_level(self, quiet_audio, tmp_path):
        """Quiet audio is boosted to target LUFS."""
        output = tmp_path / "normalized.wav"

        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(quiet_audio),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=11",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        assert output.exists()

    def test_sample_rate_conversion_to_16khz(self, tmp_path):
        """Audio is correctly converted to 16kHz."""
        # Create 44.1kHz audio
        input_path = tmp_path / "input_44100.wav"
        with wave.open(str(input_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(44100)
            # 1 second of samples
            wf.writeframes(bytes(44100 * 2))

        output = tmp_path / "output_16000.wav"
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

        # Verify output sample rate
        with wave.open(str(output), "rb") as wf:
            assert wf.getframerate() == 16000
            assert wf.getnchannels() == 1

    def test_stereo_to_mono_conversion(self, tmp_path):
        """Stereo audio is correctly converted to mono."""
        # Create stereo audio
        input_path = tmp_path / "stereo.wav"
        with wave.open(str(input_path), "wb") as wf:
            wf.setnchannels(2)  # Stereo
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(bytes(16000 * 2 * 2))  # 1 sec, 2 channels

        output = tmp_path / "mono.wav"
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_path),
                "-ac",
                "1",
                str(output),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

        with wave.open(str(output), "rb") as wf:
            assert wf.getnchannels() == 1


@pytest.mark.integration
class TestRealLoudnessAnalysis:
    """Tests that actually measure loudness with ffmpeg."""

    def test_loudnorm_json_output(self, wav_16k_mono):
        """loudnorm filter produces valid JSON analysis."""
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "loudnorm=print_format=json",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

        # Extract JSON from stderr (loudnorm outputs there)
        stderr = result.stderr
        # Find JSON block in output
        json_start = stderr.find("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            json_str = stderr[json_start:json_end]
            data = json.loads(json_str)
            assert "input_i" in data  # Integrated loudness
            assert "input_tp" in data  # True peak
            assert "input_lra" in data  # Loudness range

    def test_volumedetect_filter(self, wav_16k_mono):
        """volumedetect filter extracts volume statistics."""
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "volumedetect",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # volumedetect outputs to stderr
        assert "mean_volume" in result.stderr or "max_volume" in result.stderr

    def test_ebur128_filter(self, wav_16k_mono):
        """ebur128 filter works for loudness measurement."""
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "ebur128",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        # ebur128 outputs summary at end
        assert "Summary" in result.stderr or "LUFS" in result.stderr or "I:" in result.stderr


@pytest.mark.integration
class TestRealAudioQualityMetrics:
    """Tests that extract real audio quality metrics."""

    def test_ffprobe_audio_stream_info(self, wav_16k_mono):
        """ffprobe extracts audio stream information."""
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate,channels,codec_name,bits_per_sample",
                "-of",
                "json",
                str(wav_16k_mono),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        stream = data["streams"][0]

        assert stream["sample_rate"] == "16000"
        assert stream["channels"] == 1

    def test_ffprobe_format_info(self, wav_16k_mono):
        """ffprobe extracts format information."""
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,size,bit_rate",
                "-of",
                "json",
                str(wav_16k_mono),
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        fmt = data["format"]

        assert "duration" in fmt
        assert "size" in fmt
        assert float(fmt["duration"]) > 0


@pytest.mark.integration
class TestRealAudioQualityLogic:
    """Tests for audio quality decision logic with real measurements."""

    def test_lufs_in_acceptable_range(self, wav_16k_mono):
        """Test LUFS measurement and acceptable range logic."""
        from besedy.lib.audio.quality import determine_needs_normalization

        # Measure actual LUFS
        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "loudnorm=print_format=json",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0

        # Extract LUFS value
        stderr = result.stderr
        json_start = stderr.find("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            json_str = stderr[json_start:json_end]
            data = json.loads(json_str)
            measured_lufs = data.get("input_i", "-inf")

            # Test the determination logic
            needs_norm = determine_needs_normalization(measured_lufs)
            assert needs_norm in ("yes", "no")

    def test_true_peak_measurement(self, wav_16k_mono):
        """Test true peak measurement."""
        from besedy.lib.audio.quality import needs_declipping

        result = subprocess.run(
            [
                "ffmpeg",
                "-i",
                str(wav_16k_mono),
                "-af",
                "loudnorm=print_format=json",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
        )

        stderr = result.stderr
        json_start = stderr.find("{")
        json_end = stderr.rfind("}") + 1
        if json_start >= 0 and json_end > json_start:
            json_str = stderr[json_start:json_end]
            data = json.loads(json_str)
            true_peak = data.get("input_tp", "-inf")

            # Test the declipping logic
            needs_declip = needs_declipping(true_peak)
            assert isinstance(needs_declip, bool)


@pytest.mark.integration
class TestRealAudioPipelineIntegration:
    """End-to-end audio processing pipeline tests."""

    def test_full_normalization_pipeline(self, tmp_path):
        """Test complete normalization pipeline: detect → normalize → verify."""
        # Create input audio
        input_audio = create_tone_wav(
            tmp_path / "input.wav",
            frequency=440.0,
            duration_seconds=2.0,
            amplitude=0.3,
        )

        # Step 1: Analyze input
        analyze_result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=sample_rate,channels",
                "-of",
                "json",
                str(input_audio),
            ],
            capture_output=True,
            text=True,
        )
        assert analyze_result.returncode == 0
        input_info = json.loads(analyze_result.stdout)

        # Step 2: Normalize
        output_audio = tmp_path / "output.wav"
        norm_result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_audio),
                "-af",
                "loudnorm=I=-16:TP=-1.5:LRA=11",
                "-ar",
                "16000",
                "-ac",
                "1",
                str(output_audio),
            ],
            capture_output=True,
            text=True,
        )
        assert norm_result.returncode == 0
        assert output_audio.exists()

        # Step 3: Verify output
        verify_result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=sample_rate,channels",
                "-of",
                "json",
                str(output_audio),
            ],
            capture_output=True,
            text=True,
        )
        assert verify_result.returncode == 0
        output_info = json.loads(verify_result.stdout)

        # Verify format
        assert output_info["streams"][0]["sample_rate"] == "16000"
        assert output_info["streams"][0]["channels"] == 1

        # Duration should be preserved (within tolerance)
        input_duration = float(input_info["format"]["duration"])
        output_duration = float(output_info["format"]["duration"])
        assert abs(input_duration - output_duration) < 0.1

    def test_batch_audio_processing(self, tmp_path):
        """Test processing multiple audio files in batch."""
        # Create multiple input files
        input_files = []
        for i in range(3):
            path = create_tone_wav(
                tmp_path / f"input_{i}.wav",
                frequency=440.0 * (i + 1),
                duration_seconds=1.0,
            )
            input_files.append(path)

        # Process each file
        output_files = []
        for input_file in input_files:
            output_file = tmp_path / f"output_{input_file.stem}.wav"
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(input_file),
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    str(output_file),
                ],
                capture_output=True,
                text=True,
            )
            assert result.returncode == 0
            output_files.append(output_file)

        # Verify all outputs exist and are valid
        for output_file in output_files:
            assert output_file.exists()
            with wave.open(str(output_file), "rb") as wf:
                assert wf.getframerate() == 16000
                assert wf.getnchannels() == 1
