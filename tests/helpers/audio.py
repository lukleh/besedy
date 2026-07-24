"""Audio file generation utilities for testing.

Uses only standard library `wave` module - no external dependencies.
"""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path
from typing import NamedTuple


class WavInfo(NamedTuple):
    """Information about a WAV file."""

    sample_rate: int
    channels: int
    sample_width: int
    num_frames: int
    duration_seconds: float


def create_silent_wav(
    path: Path,
    duration_seconds: float = 1.0,
    sample_rate: int = 16000,
    channels: int = 1,
) -> Path:
    """Create a silent WAV file.

    Args:
        path: Output file path.
        duration_seconds: Duration of silence.
        sample_rate: Sample rate in Hz (default 16000 for speech).
        channels: Number of channels (default 1 for mono).

    Returns:
        Path to created file.
    """
    num_frames = int(duration_seconds * sample_rate)
    # 16-bit silence (zeros)
    samples = b"\x00\x00" * num_frames * channels

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(samples)

    return path


def create_tone_wav(
    path: Path,
    frequency: float = 440.0,
    duration_seconds: float = 1.0,
    sample_rate: int = 16000,
    channels: int = 1,
    amplitude: float = 0.5,
) -> Path:
    """Create a WAV file with a sine wave tone.

    Args:
        path: Output file path.
        frequency: Tone frequency in Hz (default 440 = A4).
        duration_seconds: Duration of tone.
        sample_rate: Sample rate in Hz.
        channels: Number of channels.
        amplitude: Amplitude 0-1 (default 0.5 to avoid clipping).

    Returns:
        Path to created file.
    """
    num_frames = int(duration_seconds * sample_rate)
    max_amplitude = 32767  # Max for 16-bit signed

    samples = []
    for i in range(num_frames):
        t = i / sample_rate
        value = int(amplitude * max_amplitude * math.sin(2 * math.pi * frequency * t))
        # Pack as 16-bit signed little-endian
        for _ in range(channels):
            samples.append(struct.pack("<h", value))

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(samples))

    return path


def get_wav_info(path: Path) -> WavInfo:
    """Get information about a WAV file.

    Args:
        path: Path to WAV file.

    Returns:
        WavInfo with sample_rate, channels, sample_width, num_frames, duration_seconds.
    """
    with wave.open(str(path), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        num_frames = wav_file.getnframes()
        duration_seconds = num_frames / sample_rate

    return WavInfo(
        sample_rate=sample_rate,
        channels=channels,
        sample_width=sample_width,
        num_frames=num_frames,
        duration_seconds=duration_seconds,
    )


def create_stereo_wav(
    path: Path,
    duration_seconds: float = 1.0,
    sample_rate: int = 44100,
) -> Path:
    """Create a stereo WAV file at non-standard sample rate.

    Useful for testing audio normalization (conversion to 16kHz mono).

    Args:
        path: Output file path.
        duration_seconds: Duration.
        sample_rate: Sample rate (default 44100).

    Returns:
        Path to created file.
    """
    return create_tone_wav(
        path,
        frequency=440.0,
        duration_seconds=duration_seconds,
        sample_rate=sample_rate,
        channels=2,
        amplitude=0.3,
    )


def create_speech_like_wav(
    path: Path,
    duration_seconds: float = 3.0,
    sample_rate: int = 16000,
) -> Path:
    """Create a WAV file with speech-like audio using vowel formants.

    Generates audio that resembles human speech by combining:
    - Fundamental frequency (pitch) around 150Hz
    - Vowel formants (F1, F2, F3) for "ah" and "ee" sounds
    - Amplitude modulation to simulate syllables

    This is more likely to trigger ASR models than a simple sine wave.

    Args:
        path: Output file path.
        duration_seconds: Duration of audio.
        sample_rate: Sample rate in Hz (default 16000 for speech).

    Returns:
        Path to created file.
    """
    num_frames = int(duration_seconds * sample_rate)
    max_amplitude = 32767 * 0.4  # Keep headroom

    # Speech parameters
    f0 = 150.0  # Fundamental frequency (male voice pitch)

    # Vowel formants - alternate between "ah" and "ee" sounds
    vowels = [
        # "ah" as in "father": F1=700, F2=1200, F3=2500
        {"f1": 700, "f2": 1200, "f3": 2500},
        # "ee" as in "see": F1=300, F2=2300, F3=3000
        {"f1": 300, "f2": 2300, "f3": 3000},
    ]

    # Syllable duration in seconds
    syllable_duration = 0.3
    syllable_frames = int(syllable_duration * sample_rate)

    samples = []
    for i in range(num_frames):
        t = i / sample_rate

        # Select vowel based on position (alternate every syllable)
        syllable_idx = (i // syllable_frames) % len(vowels)
        vowel = vowels[syllable_idx]

        # Generate harmonics with formant filtering
        # Fundamental + harmonics weighted by distance from formants
        value = 0.0

        # Add harmonics (fundamental and overtones)
        for harmonic in range(1, 10):
            freq = f0 * harmonic
            # Weight by proximity to formants (simplified formant filter)
            weight = 0.1
            for formant_key in ["f1", "f2", "f3"]:
                formant_freq = vowel[formant_key]
                # Gaussian-like weighting around formant
                distance = abs(freq - formant_freq) / formant_freq
                weight += math.exp(-distance * distance * 4)

            weight = min(weight, 1.0) / harmonic  # Reduce higher harmonics
            value += weight * math.sin(2 * math.pi * freq * t)

        # Amplitude envelope - syllable shape (attack-sustain-release)
        syllable_pos = (i % syllable_frames) / syllable_frames
        if syllable_pos < 0.1:
            envelope = syllable_pos / 0.1  # Attack
        elif syllable_pos > 0.8:
            envelope = (1.0 - syllable_pos) / 0.2  # Release
        else:
            envelope = 1.0  # Sustain

        # Add small gaps between syllables
        if syllable_pos > 0.95:
            envelope = 0.0

        value = int(max_amplitude * value * envelope)
        value = max(-32767, min(32767, value))  # Clamp
        samples.append(struct.pack("<h", value))

    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(samples))

    return path
