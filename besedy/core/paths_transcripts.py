"""Transcript path parsing, timestamp extraction, and validation helpers."""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from besedy.core.paths_common import (
    SAFE_COMPONENT_PATTERN,
    SHA256_HASH_PATTERN,
    WAV_EXTENSION,
)


def _extract_timestamp(path: Path, pattern: str, strip_slash: bool = False) -> str | None:
    """Extract timestamp matching pattern from a path name."""
    name = path.name.rstrip("/") if strip_slash else path.name
    match = re.search(pattern, name)
    return match.group(1) if match else None


def extract_timestamp_from_catalog(path: Path) -> str | None:
    """Extract <ts> from audio_catalog_<ts>.csv."""
    return _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})\.csv$")


def extract_timestamp_from_loudness_catalog(path: Path) -> str | None:
    """Extract <ts> from audio_catalog_<ts>_loudness.csv."""
    return _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})_loudness\.csv$")


def extract_timestamp_from_normalized_catalog(path: Path) -> str | None:
    """Extract <ts> from audio_catalog_<ts>_normalized or _loudness_normalized."""
    result = _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})_normalized\.csv$")
    if result:
        return result
    return _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})_loudness_normalized\.csv$")


def extract_timestamp_from_archived_catalog(path: Path) -> str | None:
    """Extract <ts> from audio_catalog_<ts>_loudness_archived.csv."""
    return _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})_loudness_archived\.csv$")


def extract_timestamp_from_joined_catalog(path: Path) -> str | None:
    """Extract <ts> from audio_catalog_<ts>_joined.csv."""
    return _extract_timestamp(path, r"audio_catalog_(\d{8}_\d{6})_joined\.csv$")


def extract_timestamp_from_transcripts_root(path: Path) -> str | None:
    """Extract <ts> from a transcripts run root directory name."""
    ts = _extract_timestamp(path, r"transcripts_(\d{8}_\d{6})(?:_.+)?$", strip_slash=True)
    if ts:
        return ts
    return extract_timestamp_from_enhanced_transcripts_root(path)


def extract_run_id_from_transcripts_root(path: Path) -> str | None:
    """Extract <run_id> from transcripts_<run_id> directory name."""
    run_id = _extract_timestamp(path, r"transcripts_(\d{8}_\d{6}(?:_.+)?)$", strip_slash=True)
    if run_id:
        return run_id
    return extract_run_id_from_enhanced_transcripts_root(path)


def extract_timestamp_from_enhanced_transcripts_root(path: Path) -> str | None:
    """Extract <ts> from transcripts_enhanced_<ts>_<variant> directory name."""
    return _extract_timestamp(path, r"transcripts_enhanced_(\d{8}_\d{6})_.+$", strip_slash=True)


def extract_run_id_from_enhanced_transcripts_root(path: Path) -> str | None:
    """Extract <run_id> from transcripts_enhanced_<run_id> directory name."""
    return _extract_timestamp(path, r"transcripts_enhanced_(\d{8}_\d{6}_.+)$", strip_slash=True)


def extract_timestamp_from_parquet_root(path: Path) -> str | None:
    """Extract <ts> from transcripts_parquet_<ts> directory name."""
    return _extract_timestamp(path, r"transcripts_parquet_(\d{8}_\d{6})(?:_.+)?$", strip_slash=True)


def extract_run_id_from_parquet_root(path: Path) -> str | None:
    """Extract <run_id> from transcripts_parquet_<run_id> directory name."""
    return _extract_timestamp(path, r"transcripts_parquet_(\d{8}_\d{6}(?:_.+)?)$", strip_slash=True)


def extract_timestamp_from_speaker_clusters_root(path: Path) -> str | None:
    """Extract <ts> from speaker_clusters_<ts> directory name."""
    return _extract_timestamp(path, r"speaker_clusters_(\d{8}_\d{6})(?:_.+)?$", strip_slash=True)


def extract_run_id_from_speaker_clusters_root(path: Path) -> str | None:
    """Extract <run_id> from speaker_clusters_<run_id> directory name."""
    return _extract_timestamp(path, r"speaker_clusters_(\d{8}_\d{6}(?:_.+)?)$", strip_slash=True)


def extract_timestamp_from_merged_root(path: Path) -> str | None:
    """Extract <ts> from transcripts_merged_<ts> directory name."""
    return _extract_timestamp(path, r"transcripts_merged_(\d{8}_\d{6})(?:_.+)?$", strip_slash=True)


def extract_run_id_from_merged_root(path: Path) -> str | None:
    """Extract <run_id> from transcripts_merged_<run_id> directory name."""
    return _extract_timestamp(path, r"transcripts_merged_(\d{8}_\d{6}(?:_.+)?)$", strip_slash=True)


def assert_catalog_transcripts_alignment(
    catalog_path: Path,
    normalized_catalog_path: Path,
    transcripts_root: Path,
) -> None:
    """Ensure catalog, normalized catalog, and transcripts root share a timestamp."""
    ts_catalog = extract_timestamp_from_catalog(catalog_path.resolve())
    ts_norm = extract_timestamp_from_normalized_catalog(normalized_catalog_path.resolve())
    ts_transcripts = extract_timestamp_from_transcripts_root(transcripts_root.resolve())

    problems = []
    if not ts_catalog:
        problems.append(f"catalog path lacks timestamp: {catalog_path}")
    if not ts_norm:
        problems.append(f"normalized catalog path lacks timestamp: {normalized_catalog_path}")
    if not ts_transcripts:
        problems.append(f"transcripts path lacks timestamp: {transcripts_root}")

    if problems:
        raise RuntimeError(" ; ".join(problems))

    if len({ts_catalog, ts_norm, ts_transcripts}) != 1:
        raise RuntimeError(
            "Timestamp mismatch: "
            f"catalog={ts_catalog}, normalized={ts_norm}, transcripts={ts_transcripts}"
        )


def assert_transcripts_parquet_alignment(
    transcripts_root: Path,
    parquet_root: Path,
) -> None:
    """Ensure transcripts and parquet roots share the same timestamp."""
    if not parquet_root.exists():
        raise RuntimeError(f"parquet path not found: {parquet_root}")

    run_id_transcripts = require_run_id_from_transcripts_root(transcripts_root)
    run_id_parquet = extract_run_id_from_parquet_root(parquet_root.resolve())

    if not run_id_parquet:
        raise RuntimeError(
            "parquet path must be timestamped as transcripts_parquet_<YYYYMMDD_HHMMSS>[_<variant>]. "
            f"Got: {parquet_root}"
        )

    if run_id_parquet != run_id_transcripts:
        raise RuntimeError(
            "Timestamp mismatch between transcripts and parquet: "
            f"transcripts={run_id_transcripts}, parquet={run_id_parquet}"
        )


def assert_transcripts_speaker_clusters_alignment(
    transcripts_root: Path,
    speaker_clusters_root: Path,
) -> None:
    """Ensure transcripts and speaker_clusters roots share the same timestamp."""
    if not speaker_clusters_root.exists():
        raise RuntimeError(f"speaker_clusters path not found: {speaker_clusters_root}")

    run_id_transcripts = require_run_id_from_transcripts_root(transcripts_root)
    run_id_clusters = extract_run_id_from_speaker_clusters_root(speaker_clusters_root.resolve())

    if not run_id_clusters:
        raise RuntimeError(
            "speaker_clusters path must be timestamped as speaker_clusters_<YYYYMMDD_HHMMSS>[_<variant>]. "
            f"Got: {speaker_clusters_root}"
        )

    if run_id_clusters != run_id_transcripts:
        raise RuntimeError(
            "Timestamp mismatch between transcripts and speaker_clusters: "
            f"transcripts={run_id_transcripts}, speaker_clusters={run_id_clusters}"
        )


def require_timestamped_transcripts_root(transcripts_root: Path) -> str:
    """Ensure transcripts root encodes a timestamp; return the timestamp."""
    ts = extract_timestamp_from_transcripts_root(transcripts_root.resolve())
    if not ts:
        raise RuntimeError(
            "transcripts path must be timestamped as "
            "transcripts_<YYYYMMDD_HHMMSS>[_<variant>] "
            "or transcripts_enhanced_<YYYYMMDD_HHMMSS>_<variant>. "
            f"Got: {transcripts_root}"
        )
    return ts


def require_run_id_from_transcripts_root(transcripts_root: Path) -> str:
    """Ensure transcripts root encodes a run id; return the run id."""
    run_id = extract_run_id_from_transcripts_root(transcripts_root.resolve())
    if not run_id:
        raise RuntimeError(
            "transcripts path must be timestamped as "
            "transcripts_<YYYYMMDD_HHMMSS>[_<variant>] "
            "or transcripts_enhanced_<YYYYMMDD_HHMMSS>_<variant>. "
            f"Got: {transcripts_root}"
        )
    return run_id


def sanitize_component(value: str) -> str:
    """Return a filesystem-safe component using shared sanitisation rules."""
    cleaned = SAFE_COMPONENT_PATTERN.sub("_", value.strip())
    return cleaned.strip("_")


def hash_component_from_sha(sha: str) -> str:
    """Build a safe directory component derived from a SHA256 hash."""
    lowered = sha.lower().strip()
    sanitized = sanitize_component(lowered)
    return sanitized or lowered


def require_valid_hash_stem(audio_path: Path) -> str:
    """Validate audio_path.stem is a valid SHA-256 hash and return it."""
    stem = audio_path.stem.lower()
    if not SHA256_HASH_PATTERN.match(stem):
        raise ValueError(
            f"Invalid audio filename: expected 64-character SHA-256 hash, "
            f"got {stem!r} ({len(stem)} chars).\n"
            f"Run 'just catalog stage-audio' to properly stage audio files."
        )
    return stem


def derive_common_root(paths: list[str]) -> Path | None:
    """Derive common root directory from a list of file paths."""
    if not paths:
        return None
    try:
        from os.path import commonpath

        common = commonpath(paths)
        common_path = Path(common)
        if common_path.is_file():
            common_path = common_path.parent
        return common_path if common_path.is_dir() else None
    except ValueError:
        return None


def iter_transcript_paths(root: Path) -> Iterable[Path]:
    """Yield transcript.json files under the provided root for registered backends."""
    from besedy.lib.backend_ids import TRANSCRIPTION_WORKFLOW_IDS

    allowed = set(TRANSCRIPTION_WORKFLOW_IDS)
    for candidate in root.rglob("transcript.json"):
        if not candidate.is_file():
            continue
        try:
            relative = candidate.relative_to(root)
        except ValueError:
            continue
        parts = relative.parts
        if len(parts) == 1 and parts[0] == "transcript.json":
            yield candidate
            continue
        if len(parts) >= 4 and parts[0] in allowed:
            yield candidate


def parse_transcript_components(path: Path, root: Path) -> tuple[str, str, str] | None:
    """Return (workflow, model_component, audio_hash) for a transcript path."""
    try:
        relative = path.relative_to(root)
    except ValueError:
        return None

    parts = relative.parts
    if len(parts) < 4:
        return None
    workflow, model_component, audio_hash = parts[:3]
    return workflow, model_component, audio_hash


def validate_mono_wav_16k(audio_path: Path, sample_rate: int, channel_count: int) -> None:
    """Ensure audio matches the shared WAV/mono/16 kHz contract."""
    from besedy.config.settings import config

    if audio_path.suffix.lower() != WAV_EXTENSION:
        raise ValueError(f"Expected a WAV file, but got {audio_path.suffix!r} for {audio_path}.")

    expected_rate = config.audio.sample_rate
    if sample_rate != expected_rate:
        raise ValueError(
            f"Audio must be sampled at {expected_rate} Hz; {audio_path} is {sample_rate} Hz."
        )

    if channel_count != 1:
        raise ValueError(f"Audio must be mono; {audio_path} reports {channel_count} channel(s).")
