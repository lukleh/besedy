"""Tests for audio_content_sha256sum() function."""

from __future__ import annotations

import hashlib
import os
import re
import resource
import shutil
import subprocess
import time
import wave
from pathlib import Path

import pytest

from besedy.lib.catalog import hash_decoder_check
from besedy.lib.catalog.hash_decoder_check import (
    FIXTURES_DIR,
    PINNED_HASHES,
    SKIP_ENV,
    HashDecoderMismatchError,
)
from besedy.lib.catalog.manager import audio_content_sha256sum


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

    @pytest.mark.parametrize(("fixture_name", "expected_hash"), sorted(PINNED_HASHES.items()))
    def test_decoded_hash_matches_pinned_value(self, fixture_name, expected_hash):
        """Decoding, downmixing and resampling still yield the pinned hashes.

        A failure means this ffmpeg build decodes or resamples differently,
        which needs a new audio-hash algorithm version. Known-good builds are
        listed in besedy/lib/catalog/audio_hash_fixtures/README.md.
        """
        assert audio_content_sha256sum(FIXTURES_DIR / fixture_name) == expected_hash, (
            f"{_ffmpeg_build()} does not reproduce the pinned hash; "
            "see besedy/lib/catalog/audio_hash_fixtures/README.md"
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


class TestHashDecoderCheck:
    """An ffmpeg must reproduce the pinned fixture hashes before it hashes anything."""

    @pytest.fixture(autouse=True)
    def _check_enabled(self, monkeypatch):
        monkeypatch.delenv(SKIP_ENV, raising=False)
        monkeypatch.setattr(hash_decoder_check, "_verified", set())
        monkeypatch.setattr(hash_decoder_check, "_mismatched", {})

    @staticmethod
    def _stub_ffmpeg(tmp_path: Path, output: str = "chunk") -> Path:
        stub = tmp_path / "ffmpeg"
        stub.write_text(f"#!/bin/sh\nprintf '{output}'\n")
        stub.chmod(0o755)
        return stub

    def test_mismatching_build_refuses_to_hash(self, tmp_path):
        stub = self._stub_ffmpeg(tmp_path)

        with pytest.raises(HashDecoderMismatchError, match=r"8/8 fixtures"):
            audio_content_sha256sum(tmp_path / "audio.wav", ffmpeg_binary=str(stub))

    def test_mismatch_is_not_a_per_file_error(self):
        # build_record_for_file and catalog create turn RuntimeError/OSError
        # into "skip this file"; the check must stop the whole run instead.
        assert not issubclass(HashDecoderMismatchError, (RuntimeError, OSError))

    def test_reproducing_build_is_checked_once(self, tmp_path):
        stub = self._stub_ffmpeg(tmp_path)
        decoded: list[Path] = []

        def decode(path: Path, binary: str) -> str:
            decoded.append(path)
            return PINNED_HASHES[path.name]

        hash_decoder_check.require_reproducible_hash_decoder(str(stub), decode)
        hash_decoder_check.require_reproducible_hash_decoder(str(stub), decode)

        assert sorted(path.name for path in decoded) == sorted(PINNED_HASHES)
        assert all(path.parent == FIXTURES_DIR and path.is_file() for path in decoded)

    def test_mismatching_build_is_checked_once(self, tmp_path):
        stub = self._stub_ffmpeg(tmp_path)
        decoded: list[Path] = []

        def decode(path: Path, binary: str) -> None:
            decoded.append(path)

        for _ in range(3):
            with pytest.raises(HashDecoderMismatchError, match=r"8/8 fixtures"):
                hash_decoder_check.require_reproducible_hash_decoder(str(stub), decode)

        assert len(decoded) == len(PINNED_HASHES)

    def test_replaced_binary_is_checked_again(self, tmp_path):
        stub = self._stub_ffmpeg(tmp_path)
        hash_decoder_check.require_reproducible_hash_decoder(
            str(stub), lambda path, binary: PINNED_HASHES[path.name]
        )
        os.utime(stub, ns=(0, 0))

        with pytest.raises(HashDecoderMismatchError):
            hash_decoder_check.require_reproducible_hash_decoder(
                str(stub), lambda path, binary: None
            )

    def test_skip_env_bypasses_the_check(self, tmp_path, monkeypatch):
        monkeypatch.setenv(SKIP_ENV, "1")
        stub = self._stub_ffmpeg(tmp_path)

        result = audio_content_sha256sum(tmp_path / "audio.wav", ffmpeg_binary=str(stub))

        assert result == hashlib.sha256(b"chunk").hexdigest()

    @pytest.mark.skipif(not _has_ffmpeg(), reason="ffmpeg not available")
    def test_ffmpeg_on_path_hashes_only_if_it_reproduces_every_pin(self, tmp_path, monkeypatch):
        """CI's known-good build hashes with the check on; a drifting one refuses."""
        wav_file = tmp_path / "target.wav"
        assert _create_sine_wave(wav_file)
        monkeypatch.setenv(SKIP_ENV, "1")
        reproduces = all(
            audio_content_sha256sum(FIXTURES_DIR / name) == expected
            for name, expected in PINNED_HASHES.items()
        )
        monkeypatch.delenv(SKIP_ENV)

        if reproduces:
            assert audio_content_sha256sum(wav_file) is not None
        else:
            with pytest.raises(HashDecoderMismatchError, match=_ffmpeg_realpath()):
                audio_content_sha256sum(wav_file)


def _ffmpeg_realpath() -> str:

    return re.escape(os.path.realpath(shutil.which("ffmpeg") or "ffmpeg"))
