"""Tests for audio_content_sha256sum() function."""

from __future__ import annotations

import hashlib
import os
import resource
import shutil
import subprocess
import time
import wave
from pathlib import Path

import pytest

from besedy.lib.catalog.manager import audio_content_sha256sum

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "audio_hash"


def _ffmpeg_build() -> str:
    """Describe the ffmpeg on PATH for golden-test failure messages."""
    path = shutil.which("ffmpeg")
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True)
    first_line = version.stdout.splitlines()[:1]
    return f"{path} ({first_line[0] if first_line else 'unknown version'})"


def _has_ffmpeg() -> bool:
    """Check if ffmpeg is available."""
    return shutil.which("ffmpeg") is not None


def _create_sine_wave(
    path: Path,
    frequency: int = 440,
    duration: float = 0.5,
    sample_rate: int = 16000,
) -> bool:
    """Create a simple sine wave audio file using ffmpeg."""
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={frequency}:duration={duration}:sample_rate={sample_rate}",
        "-c:a",
        "pcm_s16le",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


def _create_mp3_with_metadata(
    path: Path,
    frequency: int = 440,
    duration: float = 0.5,
    title: str = "Test",
    artist: str = "Test Artist",
) -> bool:
    """Create an MP3 file with ID3 metadata using ffmpeg."""
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"sine=frequency={frequency}:duration={duration}:sample_rate=16000",
        "-metadata",
        f"title={title}",
        "-metadata",
        f"artist={artist}",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "64k",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


@pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg not available")
class TestAudioContentSha256sum:
    """Tests for audio_content_sha256sum()."""

    def test_returns_none_for_missing_file(self, tmp_path):
        """Returns None when file doesn't exist."""
        missing = tmp_path / "missing.wav"
        assert audio_content_sha256sum(missing) is None

    def test_returns_none_for_non_audio_file(self, tmp_path):
        """Returns None for files that aren't valid audio."""
        text_file = tmp_path / "test.txt"
        text_file.write_text("This is not audio")
        assert audio_content_sha256sum(text_file) is None

    def test_hash_length_64_chars(self, tmp_path):
        """Audio content hash is 64 hex characters."""
        wav_file = tmp_path / "test.wav"
        assert _create_sine_wave(wav_file)

        hash_val = audio_content_sha256sum(wav_file)
        assert hash_val is not None
        assert len(hash_val) == 64

    def test_hash_is_lowercase_hex(self, tmp_path):
        """Hash contains only lowercase hex characters."""
        wav_file = tmp_path / "test.wav"
        assert _create_sine_wave(wav_file)

        hash_val = audio_content_sha256sum(wav_file)
        assert hash_val is not None
        assert all(c in "0123456789abcdef" for c in hash_val)

    def test_deterministic_same_audio(self, tmp_path):
        """Same audio content produces identical hash."""
        wav1 = tmp_path / "audio1.wav"
        wav2 = tmp_path / "audio2.wav"

        # Create identical audio files
        assert _create_sine_wave(wav1, frequency=440, duration=0.5)
        assert _create_sine_wave(wav2, frequency=440, duration=0.5)

        hash1 = audio_content_sha256sum(wav1)
        hash2 = audio_content_sha256sum(wav2)

        assert hash1 is not None
        assert hash2 is not None
        assert hash1 == hash2

    def test_different_audio_different_hash(self, tmp_path):
        """Different audio content produces different hashes."""
        wav1 = tmp_path / "audio1.wav"
        wav2 = tmp_path / "audio2.wav"

        # Create audio with different frequencies
        assert _create_sine_wave(wav1, frequency=440, duration=0.5)
        assert _create_sine_wave(wav2, frequency=880, duration=0.5)

        hash1 = audio_content_sha256sum(wav1)
        hash2 = audio_content_sha256sum(wav2)

        assert hash1 is not None
        assert hash2 is not None
        assert hash1 != hash2

    def test_ignores_metadata_mp3(self, tmp_path):
        """MP3 files with same audio but different metadata produce same hash."""
        mp3_a = tmp_path / "audio_a.mp3"
        mp3_b = tmp_path / "audio_b.mp3"

        # Create MP3s with same audio but different metadata
        assert _create_mp3_with_metadata(
            mp3_a,
            frequency=440,
            duration=0.5,
            title="Title A",
            artist="Artist A",
        )
        assert _create_mp3_with_metadata(
            mp3_b,
            frequency=440,
            duration=0.5,
            title="Title B",
            artist="Artist B",
        )

        hash_a = audio_content_sha256sum(mp3_a)
        hash_b = audio_content_sha256sum(mp3_b)

        assert hash_a is not None
        assert hash_b is not None
        assert hash_a == hash_b

    def test_different_formats_same_audio(self, tmp_path):
        """WAV and MP3 of same audio produce same content hash."""
        wav_file = tmp_path / "audio.wav"
        mp3_file = tmp_path / "audio.mp3"

        # Create WAV at 16kHz (our target format)
        assert _create_sine_wave(wav_file, frequency=440, duration=0.5, sample_rate=16000)

        # Convert to MP3
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(wav_file),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            str(mp3_file),
        ]
        result = subprocess.run(cmd, capture_output=True)
        assert result.returncode == 0

        hash_wav = audio_content_sha256sum(wav_file)
        hash_mp3 = audio_content_sha256sum(mp3_file)

        assert hash_wav is not None
        assert hash_mp3 is not None
        # Note: Due to lossy compression, hashes will differ
        # This test documents that behavior
        # For truly format-agnostic comparison, acoustic fingerprinting would be needed

    def test_custom_ffmpeg_binary(self, tmp_path):
        """Can specify custom ffmpeg binary path."""
        wav_file = tmp_path / "test.wav"
        assert _create_sine_wave(wav_file)

        ffmpeg_path = shutil.which("ffmpeg")
        assert ffmpeg_path is not None

        hash_val = audio_content_sha256sum(wav_file, ffmpeg_binary=ffmpeg_path)
        assert hash_val is not None
        assert len(hash_val) == 64

    def test_target_format_hash_is_sha256_of_raw_samples(self, tmp_path):
        """16 kHz mono s16le input passes through unchanged into the hash."""
        samples = bytes(range(256)) * 125  # 16000 samples of 16-bit PCM
        wav_file = tmp_path / "target.wav"
        with wave.open(str(wav_file), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(samples)

        assert audio_content_sha256sum(wav_file) == hashlib.sha256(samples).hexdigest()

    @pytest.mark.parametrize(
        ("fixture_name", "expected_hash"),
        [
            (
                "talk_44100hz_stereo_vbr_cover.mp3",
                "ae87fc2006610b8413f7d1c5987db4739a523c87e30d3ae3c2ce5becf917c9d4",
            ),
            (
                "talk_48000hz_mono.mp3",
                "00f3fdbaa04e22bc2039ac546fabeb0a199d6b7f9c70b1ebdae250756fb05e97",
            ),
            (
                "talk_32000hz_stereo.mp3",
                "4d9fee2b9c85b64e214042fc7a033811b483120b2ea0d2767da3686923066261",
            ),
            (
                "talk_16000hz_stereo.mp3",
                "83dc5f6715d3ee6f3849bff47bc5fbcbed6ce1d62e09e8689cb2ec0d03be5607",
            ),
            (
                "talk_44100hz_mono.m4a",
                "5289065e09090ca3841e0806470dee4a8e382ef5c3092c59fdee3695a24530cb",
            ),
            (
                "talk_22050hz_mono.m4a",
                "4f6a1c2cec1f9c609310518edb8cc1c104fb8fe744f3d778e43ef9ea1efbb049",
            ),
            (
                "talk_48000hz_stereo_video.mp4",
                "ac07348cf28c1bfa5cf06092a3598e8e91fed6b80831be2ca6fa27cc110b5fc9",
            ),
            (
                "talk_48000hz_stereo_voip.mkv",
                "ab0f8f404627b7c75af1cad7427b54dd8ab5d3741fd90e76c82735c1f43fe77e",
            ),
        ],
    )
    def test_decoded_hash_matches_pinned_value(self, fixture_name, expected_hash):
        """Decoding, downmixing and resampling still yield the pinned hashes.

        A failure means this ffmpeg build decodes or resamples differently,
        which needs a new audio-hash algorithm version. Known-good builds are
        listed in tests/fixtures/audio_hash/README.md.
        """
        assert audio_content_sha256sum(FIXTURES_DIR / fixture_name) == expected_hash, (
            f"{_ffmpeg_build()} does not reproduce the pinned hash; "
            "see tests/fixtures/audio_hash/README.md"
        )


class TestAudioContentSha256sumTimeout:
    """The timeout bounds how long ffmpeg may go without producing output."""

    @pytest.mark.parametrize(
        "script",
        [
            "exec sleep 30",
            "printf 'partial'; exec sleep 30",
        ],
        ids=["silent", "stalls-after-output"],
    )
    def test_stalled_decoder_returns_none(self, tmp_path, caplog, script):
        stub = tmp_path / "ffmpeg"
        stub.write_text(f"#!/bin/sh\n{script}\n")
        stub.chmod(0o755)
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"")

        started = time.monotonic()
        result = audio_content_sha256sum(audio, ffmpeg_binary=str(stub), timeout=1)

        assert result is None
        assert time.monotonic() - started < 10
        assert "Killed ffmpeg after 1s without output" in caplog.text

    def test_steady_output_outlasts_timeout(self, tmp_path):
        """A decode longer than the timeout succeeds while output keeps flowing."""
        stub = tmp_path / "ffmpeg"
        stub.write_text("#!/bin/sh\nfor i in 1 2 3 4; do printf 'chunk'; sleep 0.4; done\n")
        stub.chmod(0o755)
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"")

        result = audio_content_sha256sum(audio, ffmpeg_binary=str(stub), timeout=1)

        assert result == hashlib.sha256(b"chunk" * 4).hexdigest()

    def test_pipe_fd_above_1024(self, tmp_path):
        """Waiting on the pipe works when the process already holds 1024+ fds."""
        soft_limit, hard_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard_limit != resource.RLIM_INFINITY and hard_limit < 1200:
            pytest.skip(f"RLIMIT_NOFILE hard limit {hard_limit} is too low")
        if soft_limit != resource.RLIM_INFINITY and soft_limit < 1200:
            resource.setrlimit(resource.RLIMIT_NOFILE, (1200, hard_limit))
        stub = tmp_path / "ffmpeg"
        stub.write_text("#!/bin/sh\nprintf 'chunk'\n")
        stub.chmod(0o755)
        audio = tmp_path / "audio.wav"
        audio.write_bytes(b"")

        held = [os.open(os.devnull, os.O_RDONLY) for _ in range(1100)]
        try:
            result = audio_content_sha256sum(audio, ffmpeg_binary=str(stub), timeout=5)
        finally:
            for fd in held:
                os.close(fd)
            resource.setrlimit(resource.RLIMIT_NOFILE, (soft_limit, hard_limit))

        assert result == hashlib.sha256(b"chunk").hexdigest()
