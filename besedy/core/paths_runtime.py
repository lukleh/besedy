"""Runtime-root and artifact-directory helpers for Besedy."""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

from besedy.core.paths_common import (
    PROJECT_ROOT,
    WebEnvMode,
    normalize_runtime_root,
    prefer_home_or_existing_legacy,
    resolve_project_path,
    resolve_xdg_root,
)


def resolve_config_home() -> Path:
    """Return the Besedy config root under the home/XDG layout.

    The config home has no directory-level override (its only explicit override
    is the ``BESEDY_CONFIG`` file path); it follows ``XDG_CONFIG_HOME`` else
    ``~/.config``.
    """
    return resolve_xdg_root(
        override_env=None,
        xdg_env="XDG_CONFIG_HOME",
        default_root=Path.home() / ".config",
    )


def resolve_share_home() -> Path:
    """Return the Besedy persistent-share root under the home/XDG layout."""
    return resolve_xdg_root(
        override_env="BESEDY_SHARE_HOME",
        xdg_env="XDG_DATA_HOME",
        default_root=Path.home() / ".local" / "share",
    )


def resolve_state_home() -> Path:
    """Return the Besedy state root under the home/XDG layout."""
    return resolve_xdg_root(
        override_env="BESEDY_STATE_HOME",
        xdg_env="XDG_STATE_HOME",
        default_root=Path.home() / ".local" / "state",
    )


def resolve_cache_home() -> Path:
    """Return the Besedy cache root under the home/XDG layout."""
    return resolve_xdg_root(
        override_env="BESEDY_CACHE_HOME",
        xdg_env="XDG_CACHE_HOME",
        default_root=Path.home() / ".cache",
    )


def resolve_logs_dir() -> Path:
    """Return the default log directory for Besedy-owned runtime logs."""
    return resolve_state_home() / "logs"


def resolve_tmp_dir() -> Path:
    """Return the default temp/state root for Besedy-owned runtime outputs."""
    return resolve_state_home() / "tmp"


def resolve_external_root() -> Path:
    """Return the persistent share root for external local assets."""
    return resolve_share_home() / "external"


def resolve_models_dir() -> Path:
    """Return the preferred root for local model artifacts."""
    home_models_dir = resolve_share_home() / "models"
    legacy_models_dir = PROJECT_ROOT / "models"
    return prefer_home_or_existing_legacy(home_models_dir, legacy_models_dir)


def resolve_pretrained_models_dir() -> Path:
    """Return the preferred root for pretrained model assets."""
    home_models_dir = resolve_share_home() / "pretrained_models"
    legacy_models_dir = PROJECT_ROOT / "pretrained_models"
    return prefer_home_or_existing_legacy(home_models_dir, legacy_models_dir)


def resolve_web_state_dir(*parts: str) -> Path:
    """Return a path under the Besedy web-state root."""
    return resolve_state_home().joinpath("web", *parts)


def resolve_web_cache_dir(*parts: str) -> Path:
    """Return a path under the Besedy web-cache root."""
    return resolve_cache_home().joinpath("web", *parts)


def resolve_rag_colbert_root() -> Path:
    """Return the default host root for ColBERT bundle state."""
    return resolve_tmp_dir() / "rag_colbert"


def resolve_rag_phase1_root() -> Path:
    """Return the default host root for legacy phase-1 RAG indexes."""
    return resolve_tmp_dir() / "rag_phase1"


def resolve_web_env_path(mode: WebEnvMode, *, must_exist: bool = True) -> Path | None:
    """Resolve a web env file path for one runtime mode."""
    suffix_by_mode = {
        "development": "dev",
        "production": "prod",
        "test": "test",
    }
    override_by_mode = {
        "development": "BESEDY_WEB_ENV_DEV",
        "production": "BESEDY_WEB_ENV_PROD",
        "test": "BESEDY_WEB_ENV_TEST",
    }

    suffix = suffix_by_mode[mode]
    override = os.getenv(override_by_mode[mode], "").strip()
    if override:
        resolved = normalize_runtime_root(override)
        if not must_exist or resolved.exists():
            return resolved
        raise FileNotFoundError(f"{override_by_mode[mode]} points to missing file: {resolved}")

    canonical_path = resolve_config_home() / f"web.env.{suffix}"
    if not must_exist or canonical_path.exists():
        return canonical_path
    return None


def iter_existing_web_env_paths(
    *modes: WebEnvMode,
    include_local: bool = False,
) -> Iterable[Path]:
    """Yield existing web env files in preferred order without duplicates."""
    candidates: list[Path] = []
    for mode in modes:
        resolved = resolve_web_env_path(mode)
        if resolved is not None:
            candidates.append(resolved)

    if include_local:
        candidates.extend(
            [
                PROJECT_ROOT / "web" / ".env.local",
                PROJECT_ROOT / ".env.local",
            ]
        )

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.exists():
            continue
        seen.add(candidate)
        yield candidate


LOGS_DIR = resolve_logs_dir()
FFMPEG_LOG_DIR = LOGS_DIR / "ffmpeg"
DIARIZATION_FALLBACK_LOG_PATH = LOGS_DIR / "diarization_fallbacks.jsonl"
FRAME_VAD_LOCAL_MODEL_PATH = prefer_home_or_existing_legacy(
    resolve_share_home() / "models" / "frame_vad_multilingual_marblenet_v2.0.nemo",
    PROJECT_ROOT / "models" / "frame_vad_multilingual_marblenet_v2.0.nemo",
)


def resolve_audio_artifacts_root() -> Path:
    """Resolve a base directory for derived audio artifacts."""
    env_value = os.getenv("BESEDY_AUDIO_ARTIFACTS_ROOT")
    if env_value:
        candidate = Path(env_value).expanduser()
        return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate

    try:
        from besedy.config.settings import config

        configured = getattr(config.paths, "audio_artifacts_dir", "")
    except Exception:
        configured = ""

    if not configured:
        return PROJECT_ROOT

    candidate = Path(configured).expanduser()
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def resolve_joined_audio_root() -> Path:
    """Resolve the directory for joined audio files."""
    artifacts_root = resolve_audio_artifacts_root()

    try:
        from besedy.config.settings import config

        subdir = getattr(config.paths, "joined_audio_dir", "joined_audio")
    except Exception:
        subdir = "joined_audio"

    return artifacts_root / subdir


def resolve_original_audio_root() -> Path | None:
    """Resolve the directory for original audio backups created by `catalog join`."""
    artifacts_root = resolve_audio_artifacts_root()

    try:
        from besedy.config.settings import config

        subdir = getattr(config.paths, "original_audio_dir", "")
    except Exception:
        subdir = ""

    if not subdir:
        return None

    candidate = Path(subdir).expanduser()
    return candidate if candidate.is_absolute() else artifacts_root / candidate


def resolve_text_data_root() -> Path:
    """Resolve a base directory for text artifacts (catalogs, transcripts, parquet)."""
    env_value = os.getenv("BESEDY_TEXT_DATA_ROOT")
    if env_value:
        candidate = Path(env_value).expanduser()
        return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate

    try:
        from besedy.config.settings import config

        configured = getattr(config.paths, "text_data_dir", "")
    except Exception as exc:
        raise RuntimeError(
            "Text data root is required. Set [paths].text_data_dir in besedy.toml "
            "or BESEDY_TEXT_DATA_ROOT in the environment."
        ) from exc

    if not configured:
        raise RuntimeError(
            "Text data root is required. Set [paths].text_data_dir in besedy.toml "
            "or BESEDY_TEXT_DATA_ROOT in the environment."
        )

    candidate = Path(configured).expanduser()
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def resolve_catalogs_root() -> Path:
    """Resolve directory for catalog CSV files."""
    text_root = resolve_text_data_root()
    catalogs_dir = text_root / "catalogs"
    catalogs_dir.mkdir(parents=True, exist_ok=True)
    return catalogs_dir


def resolve_transcripts_root(root: Path | str | None = None) -> Path:
    """Resolve the current transcripts directory (timestamped)."""
    if root is not None and root != "":
        candidate = resolve_project_path(root)
        if candidate.is_symlink():
            return candidate.resolve()
        inner_symlink = candidate / "transcripts"
        if inner_symlink.is_symlink():
            return inner_symlink.resolve()
        return candidate

    text_root = resolve_text_data_root()
    transcripts_dir = text_root / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)

    inner_symlink = transcripts_dir / "transcripts"
    if inner_symlink.is_symlink():
        return inner_symlink.resolve()

    return transcripts_dir


def resolve_transcripts_parent() -> Path:
    """Resolve the parent directory for transcript timestamped directories."""
    text_root = resolve_text_data_root()
    transcripts_dir = text_root / "transcripts"
    transcripts_dir.mkdir(parents=True, exist_ok=True)
    return transcripts_dir


def resolve_transcripts_parquet_parent() -> Path:
    """Resolve the parent directory for parquet timestamped directories."""
    text_root = resolve_text_data_root()
    parquet_dir = text_root / "transcripts_parquet"
    parquet_dir.mkdir(parents=True, exist_ok=True)
    return parquet_dir
