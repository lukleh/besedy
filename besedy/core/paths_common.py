"""Shared constants and low-level helpers for Besedy path resolution."""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Literal

_CORE_DIR = Path(__file__).resolve().parent
BESEDY_ROOT = _CORE_DIR.parent
PROJECT_ROOT = BESEDY_ROOT.parent

WebEnvMode = Literal["development", "production", "test"]

TOOLS_ROOT = BESEDY_ROOT
TRANSCRIPTS_DIRNAME = "transcripts"

# Compatibility constants describe the built-in artifact layout. Runtime code
# that supports configured transcription variants must use its WorkflowConfig
# instead of consulting these defaults.
NEMO_VAD_WORKFLOW_LABEL = "canary-nemo"
FASTER_WHISPER_VAD_MODEL_FILENAME = "silero_vad_v6.onnx"
PYANNOTE_DIARIZATION_WORKFLOW_LABEL = "speaker_diarization"
PYANNOTE_DIARIZATION_MODEL_NAME = "pyannote_speaker-diarization-community-1"
WHISPERX_DIRNAME = "whisperx"

CONFIG_DIR = BESEDY_ROOT / "config"
FRAME_VAD_CONFIG_PATH = CONFIG_DIR / "frame_vad_infer_postprocess.yaml"

SAFE_COMPONENT_PATTERN = re.compile(r"[^0-9A-Za-z._-]+")
SHA256_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
WAV_EXTENSION = ".wav"
TRANSCRIPT_SIDECAR_EXTENSIONS = (".txt", ".srt", ".vtt")


def resolve_project_path(path: Path | str) -> Path:
    """Return an absolute path rooted at the repository root."""
    candidate = Path(path)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def normalize_runtime_root(path: Path | str) -> Path:
    """Resolve an override path relative to the repository root."""
    candidate = Path(path).expanduser()
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def resolve_xdg_root(
    *,
    override_env: str | None = None,
    xdg_env: str,
    default_root: Path,
) -> Path:
    """Resolve a Besedy XDG-style root, optionally honoring an env override.

    ``override_env`` names a ``BESEDY_*_HOME`` variable that, when set, takes
    precedence as an explicit root. Pass ``None`` for roots that deliberately
    have no directory override (e.g. the config home, whose only override is the
    ``BESEDY_CONFIG`` file path).
    """
    if override_env:
        override = os.getenv(override_env, "").strip()
        if override:
            return normalize_runtime_root(override)

    xdg_root = os.getenv(xdg_env, "").strip()
    base = Path(xdg_root).expanduser() if xdg_root else default_root
    return base / "lukleh" / "besedy"


def prefer_home_or_existing_legacy(home_path: Path, legacy_path: Path) -> Path:
    """Prefer the home/XDG location unless only the legacy path exists."""
    if home_path.exists() or not legacy_path.exists():
        return home_path
    return legacy_path
