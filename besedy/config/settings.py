"""Centralized configuration for Besedy.

Usage:
    from besedy.config.settings import config

    workflows = config.transcription_workflows
    rate = config.audio.sample_rate
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from dotenv import load_dotenv

from besedy.core.paths_common import resolve_xdg_root
from besedy.lib.workflow.language import (
    LEGACY_DEFAULT_LANGUAGE,
    normalize_config_language,
    validate_workflow_language,
)

load_dotenv()


@dataclass
class PathsConfig:
    """Output directory paths for pipeline artifacts.

    Attributes:
        audio_artifacts_dir: Base directory for normalized, archived, and joined
            audio artifacts. Leave empty to write them under the repository root.
        joined_audio_dir: Subdirectory under audio_artifacts_dir for joined
            audio files created by `catalog join`. Defaults to "joined_audio".
        original_audio_dir: Directory for backup of original source audio files
            after joining. If empty, originals are left in place. If relative,
            resolves under audio_artifacts_dir.
        text_data_dir: Base directory for text artifacts (catalog CSVs,
            transcripts, parquet exports, speaker clusters). Leave empty to
            write text artifacts under the repository root. When set, creates
            catalogs/, transcripts/, and transcripts_parquet/ subdirectories.
        sources_dir: Directory for recording sources (URLs/files) managed by
            the web app. Defaults to text_data_dir when empty.
        transcripts_dir: Directory name for transcript JSON files, organized as
            {workflow}/{output_component}/{audio_hash}/transcript.json.
        speaker_clusters_dir: Directory name for speaker clustering results from
            cross-file speaker matching.
    """

    transcripts_dir: str
    speaker_clusters_dir: str
    audio_artifacts_dir: str = ""
    joined_audio_dir: str = "joined_audio"
    original_audio_dir: str = ""
    text_data_dir: str = ""
    sources_dir: str = ""


@dataclass
class AudioConfig:
    """Audio processing configuration.

    Attributes:
        sample_rate: Target sample rate in Hz. Must be 16000 - all workflows
            (canary-nemo, faster-whisper, whisperx) expect 16kHz mono WAV.
            Changing this requires re-staging all audio files.
    """

    sample_rate: int


@dataclass
class TranscriptionWorkflowConfig:
    """Configured transcription workflow variants.

    Each entry describes a concrete backend/model/strategy combination.
    """

    workflow_id: str
    workflow_label: str
    model: str
    language: str
    vad_model: str | None = None
    align_model: str | None = None
    strategy: str | None = None
    pipeline_default: bool = True
    expected_default: bool = True


@dataclass
class VadConfig:
    """Voice Activity Detection configuration.

    Attributes:
        min_silence_ms: Minimum silence duration (ms) between speech segments.
            Lower values create more segments; higher values merge adjacent speech.
            Typical range: 100-2000ms. Optional: omit to use backend defaults.
        filter_enabled: Whether to filter non-speech segments using VAD.
        word_timestamps: Request word-level timestamps from ASR models.
            Required for merge pipeline alignment.
    """

    filter_enabled: bool
    word_timestamps: bool
    min_silence_ms: int | None = None


@dataclass
class DiarizationConfig:
    """Speaker diarization configuration for pyannote.

    Attributes:
        min_speakers: Minimum expected number of speakers.
        max_speakers: Maximum expected number of speakers.
        spectral_p_value: Spectral clustering p-value for speaker separation.
            Lower = more aggressive separation (more speakers detected).
            Higher = more conservative (fewer speakers). Range: 0.1-0.5.
            Default 0.22 works well for 2-4 speaker recordings.
    """

    min_speakers: int
    max_speakers: int
    spectral_p_value: float


@dataclass
class AnalysisConfig:
    """Configuration for analysis commands.

    Attributes:
        cross_model_limit: Maximum cross-model comparisons per run.
            Limits memory usage for large datasets.
        sample_files: Number of files to sample for aggregate statistics.
        sample_hashes: Number of audio hashes to sample for detailed analysis.
        max_words_per_file: Maximum words per file for word-level analysis.
            Truncates long transcripts to limit memory usage.
    """

    cross_model_limit: int
    sample_files: int
    sample_hashes: int
    max_words_per_file: int


@dataclass
class NemoConfig:
    """NeMo-specific configuration.

    Attributes:
        min_silence_duration: Minimum silence duration (seconds) for NeMo's
            internal VAD. Affects segment boundary detection. Range: 0.05-0.5.
        precision: Decimal precision for timestamp rounding in NeMo output.
    """

    min_silence_duration: float
    precision: int


@dataclass
class WebConfig:
    """Web-facing configuration shared with jobs that serve web workflows."""

    superadmin_email: str | None = None
    deep_search_default_instructions: str | None = None


@dataclass
class RagConfig:
    """RAG model configuration.

    Attributes:
        colbert_model: Hugging Face id of the ColBERT retrieval model. Empty
            means use the built-in default (jinaai/jina-colbert-v2). Overridden
            by the RAG_COLBERT_MODEL env var and by explicit CLI/API values.
            Note the built-in default is CC-BY-NC-4.0 (non-commercial); set a
            permissively-licensed model here for commercial deployments.
    """

    colbert_model: str = ""


def _load_transcription_workflows(
    data: dict[str, Any],
) -> list[TranscriptionWorkflowConfig]:
    raw = data.get("transcription_workflows")
    if not raw:
        raise KeyError(
            "Missing 'transcription_workflows' in config. "
            "Define at least one [[transcription_workflows]] entry."
        )
    if not isinstance(raw, list):
        raise TypeError("'transcription_workflows' must be an array of tables")

    from besedy.lib.backend_ids import TRANSCRIPTION_WORKFLOW_IDS

    configs: list[TranscriptionWorkflowConfig] = []
    for idx, item in enumerate(raw):
        if not isinstance(item, dict):
            raise TypeError(f"transcription_workflows[{idx}] must be a table")
        item = cast(dict[str, Any], item)

        workflow_id = (item.get("workflow_id") or "").strip()
        if not workflow_id:
            raise ValueError(f"transcription_workflows[{idx}] missing workflow_id")
        if workflow_id not in TRANSCRIPTION_WORKFLOW_IDS:
            raise ValueError(
                f"transcription_workflows[{idx}] workflow_id {workflow_id!r} is not supported"
            )

        workflow_label = (item.get("workflow_label") or "").strip()
        if not workflow_label:
            raise ValueError(f"transcription_workflows[{idx}] missing workflow_label")

        model = (item.get("model") or "").strip()
        if not model:
            raise ValueError(f"transcription_workflows[{idx}] missing model")

        vad_model = item.get("vad_model")
        align_model = item.get("align_model")
        strategy = item.get("strategy")

        is_nemo = workflow_id in {"canary-nemo", "canary-nemo-beam"}
        context = f"transcription_workflows[{idx}]"
        language = normalize_config_language(
            item.get("language", LEGACY_DEFAULT_LANGUAGE), context=context
        )
        validate_workflow_language(workflow_id, language, align_model, context=context)

        pipeline_default = bool(item.get("pipeline_default", True))
        expected_default = bool(item.get("expected_default", pipeline_default))

        if is_nemo:
            if not strategy:
                raise ValueError(
                    f"transcription_workflows[{idx}] missing strategy for {workflow_id}"
                )
            if strategy not in {"greedy", "beam"}:
                raise ValueError(
                    f"transcription_workflows[{idx}] invalid strategy {strategy!r} for {workflow_id}"
                )
            if workflow_id == "canary-nemo" and strategy != "greedy":
                raise ValueError(
                    f'transcription_workflows[{idx}] canary-nemo must use strategy = "greedy"'
                )
            if workflow_id == "canary-nemo-beam" and strategy != "beam":
                raise ValueError(
                    f'transcription_workflows[{idx}] canary-nemo-beam must use strategy = "beam"'
                )
            if not vad_model:
                raise ValueError(f"transcription_workflows[{idx}] missing vad_model")
            if workflow_id == "canary-nemo-beam" and not align_model:
                raise ValueError(
                    f"transcription_workflows[{idx}] missing align_model for {workflow_id}"
                )
        else:
            if strategy:
                raise ValueError(
                    f"transcription_workflows[{idx}] strategy is only valid for canary-nemo"
                )
            if not vad_model:
                raise ValueError(f"transcription_workflows[{idx}] missing vad_model")
        configs.append(
            TranscriptionWorkflowConfig(
                workflow_id=workflow_id,
                workflow_label=workflow_label,
                model=model,
                language=language,
                vad_model=vad_model,
                align_model=align_model,
                strategy=strategy,
                pipeline_default=pipeline_default,
                expected_default=expected_default,
            )
        )

    return configs


@dataclass
class Config:
    """Root configuration container.

    Attributes:
        paths: Output directory paths.
        audio: Audio processing settings.
        transcription_workflows: Configured transcription workflow variants.
        vad: Voice Activity Detection settings.
        diarization: Speaker diarization settings.
        analysis: Analysis command settings.
        nemo: NeMo-specific settings.
        web: Web-facing settings used by the web app and jobs service.
        rag: RAG model settings (optional).
    """

    paths: PathsConfig
    audio: AudioConfig
    transcription_workflows: list[TranscriptionWorkflowConfig]
    vad: VadConfig
    diarization: DiarizationConfig
    analysis: AnalysisConfig
    nemo: NemoConfig
    web: WebConfig
    rag: RagConfig = field(default_factory=RagConfig)


_CONFIG: Config | None = None


def _resolve_preferred_config_home() -> Path:
    """Resolve the canonical config home without loading user configuration."""

    return resolve_xdg_root(
        xdg_env="XDG_CONFIG_HOME",
        default_root=Path.home() / ".config",
    )


def _find_config_file() -> Path:
    """Resolve config via explicit override or the canonical home path."""
    env_path = os.getenv("BESEDY_CONFIG")
    if env_path:
        path = Path(env_path)
        if path.exists():
            return path
        raise FileNotFoundError(f"BESEDY_CONFIG points to missing file: {env_path}")

    canonical_path = _resolve_preferred_config_home() / "besedy.toml"
    if canonical_path.exists():
        return canonical_path

    raise FileNotFoundError(
        "besedy.toml not found. Set BESEDY_CONFIG or create besedy.toml in the "
        "canonical config home."
    )


def resolve_config_path() -> Path:
    """Return the active Besedy config file path.

    This is the public counterpart to the internal config discovery logic and is
    intended for subprocess/runtime adapters that need to pass the same config
    file into isolated workers or containers.
    """

    return _find_config_file()


def _load_config() -> Config:
    """Load config from TOML file. Raises if file missing or incomplete."""
    config_path = resolve_config_path()

    with open(config_path, "rb") as f:
        data = tomllib.load(f)

    transcription_workflows = _load_transcription_workflows(data)

    paths_data = dict(data["paths"])
    # Key from the removed enhancement pipeline; tolerated so older configs load.
    paths_data.pop("decoded_audio_dir", None)

    return Config(
        paths=PathsConfig(**paths_data),
        audio=AudioConfig(**data["audio"]),
        transcription_workflows=transcription_workflows,
        vad=VadConfig(**data["vad"]),
        diarization=DiarizationConfig(**data["diarization"]),
        analysis=AnalysisConfig(**data["analysis"]),
        nemo=NemoConfig(**data["nemo"]),
        web=WebConfig(**data.get("web", {})),
        rag=RagConfig(**data.get("rag", {})),
    )


def get_config() -> Config:
    """Return the loaded Besedy config (lazy-loaded on first access)."""
    global _CONFIG
    if _CONFIG is None:
        _CONFIG = _load_config()
    return _CONFIG


def set_config(config: Config) -> None:
    """Override the global config instance (useful for tests/snippets)."""
    global _CONFIG
    _CONFIG = config


def reset_config() -> None:
    """Clear the cached config so it will be reloaded on next access."""
    global _CONFIG
    _CONFIG = None


class _ConfigProxy:
    def __getattr__(self, name: str):
        return getattr(get_config(), name)

    def __repr__(self) -> str:
        if _CONFIG is None:
            return "<BesedyConfig (lazy, not loaded)>"
        return repr(_CONFIG)


config = _ConfigProxy()
