"""Pytest configuration for tests."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

# Pin the suite to the repo-controlled example config so tests never read (or
# depend on) the machine-local ~/.config/lukleh/besedy/besedy.toml. Must happen
# at import time: some modules evaluate workflow config when test modules are
# collected. This also keeps besedy.toml.example load-tested.
os.environ["BESEDY_CONFIG"] = str(Path(__file__).parents[1] / "besedy.toml.example")


@pytest.fixture(scope="session", autouse=True)
def _hermetic_text_data_root(tmp_path_factory: pytest.TempPathFactory) -> None:
    """Give the suite an isolated text-data root.

    The example config leaves [paths].text_data_dir empty, and tests must never
    write into (or depend on) an operator's real data directories.
    """
    os.environ["BESEDY_TEXT_DATA_ROOT"] = str(tmp_path_factory.mktemp("besedy-text-data"))


# ---------------------------------------------------------------------------
# Session-scoped fixtures for external tool availability
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def ffmpeg_available():
    """Check if ffmpeg is available."""
    import shutil

    return shutil.which("ffmpeg") is not None


@pytest.fixture(scope="session")
def ffprobe_available():
    """Check if ffprobe is available."""
    import shutil

    return shutil.which("ffprobe") is not None


@pytest.fixture(scope="session")
def gpu_available():
    """Check if GPU (CUDA) is available."""
    try:
        import torch

        return torch.cuda.is_available()
    except ImportError:
        return False


@pytest.fixture
def require_ffmpeg(ffmpeg_available):
    """Skip test if ffmpeg is not available."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")


@pytest.fixture
def require_gpu(gpu_available):
    """Skip test if GPU is not available."""
    if not gpu_available:
        pytest.skip("GPU not available")


@pytest.fixture(scope="session")
def reference_worktree():
    """Path to pre-refactor reference worktree.

    Skips test if reference is not available.
    """
    ref = Path("worktrees/besedy-reference")
    if not ref.exists():
        pytest.skip("Reference worktree not available")
    return ref


# ---------------------------------------------------------------------------
# Audio file fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def wav_16k_mono(tmp_path):
    """Create a minimal 16kHz mono WAV file (silence)."""
    from tests.helpers.audio import create_silent_wav

    return create_silent_wav(tmp_path / "audio_16k_mono.wav", duration_seconds=1.0)


@pytest.fixture
def wav_44k_stereo(tmp_path):
    """Create a 44kHz stereo WAV file (needs conversion)."""
    from tests.helpers.audio import create_stereo_wav

    return create_stereo_wav(tmp_path / "audio_44k_stereo.wav", duration_seconds=1.0)


@pytest.fixture
def wav_with_tone(tmp_path):
    """Create a WAV file with a 440Hz tone."""
    from tests.helpers.audio import create_tone_wav

    return create_tone_wav(tmp_path / "tone_440hz.wav", frequency=440.0, duration_seconds=1.0)


# ---------------------------------------------------------------------------
# Transcript directory fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_transcripts_dir(tmp_path):
    """Create a complete transcript directory structure with multiple backends."""
    from tests.helpers.transcript import create_transcript_directory_structure

    return create_transcript_directory_structure(tmp_path)


@pytest.fixture
def sample_audio_catalog_csv(tmp_path):
    """Create a sample audio catalog CSV file."""
    import csv

    csv_path = tmp_path / "audio_catalog_20251128_120000.csv"
    fieldnames = ["Hash", "Filename", "Full Path", "Size", "Duration", "added_at", "Status"]

    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerow(
            {
                "Hash": "abc123def456",
                "Filename": "audio1.wav",
                "Full Path": str(tmp_path / "audio1.wav"),
                "Size": "1.5 MB",
                "Duration": "01:30",
                "added_at": "2025-11-28T12:00:00Z",
                "Status": "EXISTS",
            }
        )
        writer.writerow(
            {
                "Hash": "def789abc012",
                "Filename": "audio2.wav",
                "Full Path": str(tmp_path / "audio2.wav"),
                "Size": "2.0 MB",
                "Duration": "02:00",
                "added_at": "2025-11-28T12:00:00Z",
                "Status": "EXISTS",
            }
        )

    return csv_path


# ---------------------------------------------------------------------------
# Fixtures for analysis module tests
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_transcript_json():
    """Minimal canonical transcript JSON for testing."""
    return {
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
                "words": [
                    {"word": "How", "start": 3.0, "end": 3.5, "confidence": 0.92},
                    {"word": "are", "start": 3.6, "end": 4.0, "confidence": 0.89},
                    {"word": "you", "start": 4.1, "end": 5.0, "confidence": 0.88},
                ],
            },
        ]
    }


@pytest.fixture
def sample_repeated_text():
    """Text with repeated words for repetition detection testing."""
    return "Hello Hello Hello world. The quick quick brown fox jumps."


@pytest.fixture
def sample_repeated_segments():
    """Segments with repetition for segment-level repetition testing."""
    return [
        {"text": "Hello", "start": 0.0, "end": 1.0},
        {"text": "Hello", "start": 1.0, "end": 2.0},
        {"text": "Hello", "start": 2.0, "end": 3.0},
        {"text": "World", "start": 3.0, "end": 4.0},
    ]


@pytest.fixture
def sample_words_a():
    """Sample words for alignment testing - model A."""
    from besedy.lib.analysis.alignment import Word

    return [
        Word(start=0.0, end=1.0, text="Hello", confidence=0.95),
        Word(start=1.1, end=2.0, text="world", confidence=0.90),
        Word(start=2.2, end=3.0, text="test", confidence=0.85),
    ]


@pytest.fixture
def sample_words_b():
    """Sample words for alignment testing - model B (slightly offset)."""
    from besedy.lib.analysis.alignment import Word

    return [
        Word(start=0.05, end=1.05, text="Hello", confidence=0.94),
        Word(start=1.15, end=2.05, text="world", confidence=0.91),
        Word(start=2.25, end=3.05, text="test", confidence=0.86),
    ]


@pytest.fixture
def sample_words_misaligned():
    """Sample words with significant misalignment for testing edge cases."""
    from besedy.lib.analysis.alignment import Word

    return [
        Word(start=0.5, end=1.5, text="Hello", confidence=0.94),
        Word(start=2.0, end=3.0, text="there", confidence=0.91),  # Different word
        Word(start=3.5, end=4.5, text="test", confidence=0.86),
    ]
