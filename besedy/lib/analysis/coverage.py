"""Coverage verification helpers for catalog validation.

Functions to check that derived outputs (parquet, transcript exports, speaker clusters)
exist and cover all catalog entries.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

from besedy.core.paths import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
    TRANSCRIPT_SIDECAR_EXTENSIONS,
    assert_transcripts_speaker_clusters_alignment,
    iter_transcript_paths,
    parse_transcript_components,
    resolve_project_path,
)
from besedy.lib.workflow.config import get_transcription_workflows
from besedy.lib.workflow.paths import sanitize_model_identifier


def _sample_hashes(values: set[str], *, limit: int = 3) -> list[str]:
    if not values:
        return []
    return sorted(values)[:limit]


_CLUSTER_FILE_ID_RE = re.compile(r'"file_id"\s*:\s*"([a-f0-9]{64})"', re.IGNORECASE)


def _sample_file_ids_from_clusters(
    file_path: Path,
    *,
    max_samples: int = 25,
    max_bytes: int = 128 * 1024,
) -> set[str]:
    """Extract a small sample of file_id values from a clusters JSON.

    This is a lightweight sanity check for identity-contract mismatches without
    loading multi-GB JSON files.
    """
    try:
        with file_path.open("r", encoding="utf-8") as handle:
            chunk = handle.read(max_bytes)
    except OSError:
        return set()

    matches = _CLUSTER_FILE_ID_RE.findall(chunk)
    if not matches:
        return set()
    return {value.lower() for value in matches[:max_samples]}


def expected_asr_backends_from_code() -> list[str]:
    """Return ASR workflow/model identifiers derived from code defaults (not filesystem)."""
    backends = []
    for config in get_transcription_workflows(expected_only=True):
        component = config.output_component(sanitize_model_identifier)
        backends.append(f"{config.workflow_label}/{component}")
    # Preserve order while deduplicating
    return list(dict.fromkeys(backends))


def expected_diarization_backends_from_code() -> list[str]:
    """Return diarization workflow/model identifiers derived from code defaults."""
    backends = [
        f"{PYANNOTE_DIARIZATION_WORKFLOW_LABEL}/{PYANNOTE_DIARIZATION_MODEL_NAME}",
    ]
    return list(dict.fromkeys(backends))


def require_loudness_catalog(
    loudness_csv: Path,
    catalog_hashes: set[str] | None = None,
) -> tuple[bool, str | None, dict | None]:
    """Ensure loudness catalog exists and covers the catalog hashes.

    Returns (ok, error_message, stats_dict).
    """
    loudness_resolved = resolve_project_path(loudness_csv)

    if not loudness_resolved.exists():
        return False, f"Loudness catalog not found: {loudness_resolved}", None

    try:
        with loudness_resolved.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or "Hash" not in reader.fieldnames:
                return (
                    False,
                    f"Loudness catalog missing 'Hash' column: {loudness_resolved}",
                    None,
                )

            hashes: set[str] = set()
            row_count = 0
            missing_metrics = 0
            for row in reader:
                row_count += 1
                hash_value = row.get("Hash", "").strip()
                if hash_value:
                    hashes.add(hash_value)
                if not row.get("integrated_loudness_lufs", "").strip():
                    missing_metrics += 1

    except Exception as exc:
        return False, f"Failed to read loudness catalog {loudness_resolved}: {exc}", None

    if row_count == 0:
        return False, f"Loudness catalog is empty: {loudness_resolved}", None

    stats: dict[str, int] = {
        "total": len(hashes),
        "expected": len(catalog_hashes) if catalog_hashes else row_count,
        "missing": 0,
        "stale": 0,
        "missing_metrics": missing_metrics,
    }

    if catalog_hashes:
        missing = catalog_hashes - hashes
        stale = hashes - catalog_hashes
        stats["missing"] = len(missing)
        stats["stale"] = len(stale)
        if missing:
            return False, f"Loudness catalog missing {len(missing)} hashes", stats
        if stale:
            return False, f"Loudness catalog has {len(stale)} stale hashes", stats

    if missing_metrics:
        return False, f"Loudness catalog missing metrics for {missing_metrics} rows", stats

    return True, None, stats


def require_archived_audio(
    archived_csv: Path,
    catalog_hashes: set[str] | None = None,
) -> tuple[bool, str | None, dict | None]:
    """Ensure archived catalog exists and archived files cover the catalog hashes.

    Returns (ok, error_message, stats_dict).
    """
    archived_resolved = resolve_project_path(archived_csv)

    if not archived_resolved.exists():
        return False, f"Archived catalog not found: {archived_resolved}", None

    try:
        with archived_resolved.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if not reader.fieldnames or "Hash" not in reader.fieldnames:
                return (
                    False,
                    f"Archived catalog missing 'Hash' column: {archived_resolved}",
                    None,
                )

            hashes: set[str] = set()
            row_count = 0
            missing_paths = 0
            missing_files = 0
            for row in reader:
                row_count += 1
                hash_value = row.get("Hash", "").strip()
                if hash_value:
                    hashes.add(hash_value)
                compressed = row.get("Compressed Path", "").strip()
                if not compressed:
                    missing_paths += 1
                    continue
                compressed_path = Path(compressed).expanduser()
                if not compressed_path.is_absolute():
                    compressed_path = resolve_project_path(compressed_path)
                if not compressed_path.exists():
                    missing_files += 1

    except Exception as exc:
        return False, f"Failed to read archived catalog {archived_resolved}: {exc}", None

    if row_count == 0:
        return False, f"Archived catalog is empty: {archived_resolved}", None

    stats: dict[str, int] = {
        "total": len(hashes),
        "expected": len(catalog_hashes) if catalog_hashes else row_count,
        "missing": 0,
        "stale": 0,
        "missing_paths": missing_paths,
        "missing_files": missing_files,
    }

    if catalog_hashes:
        missing = catalog_hashes - hashes
        stale = hashes - catalog_hashes
        stats["missing"] = len(missing)
        stats["stale"] = len(stale)
        if missing:
            return False, f"Archived catalog missing {len(missing)} hashes", stats
        if stale:
            return False, f"Archived catalog has {len(stale)} stale hashes", stats

    if missing_paths:
        return False, f"Archived catalog missing {missing_paths} compressed paths", stats
    if missing_files:
        return False, f"Archived audio missing {missing_files} compressed files", stats

    return True, None, stats


def require_transcript_exports(
    transcripts_root: Path,
    catalog_hashes: set[str] | None = None,
) -> tuple[bool, str | None, dict | None]:
    """Ensure transcript sidecars (txt/srt/vtt) exist and cover catalog hashes.

    Returns (ok, error_message, stats_dict).
    """
    transcripts_resolved = resolve_project_path(transcripts_root)

    if not transcripts_resolved.exists():
        return False, f"Transcripts root not found: {transcripts_resolved}", None

    transcript_records: dict[tuple[str, str, str], Path] = {}
    for path in iter_transcript_paths(transcripts_resolved):
        components = parse_transcript_components(path, transcripts_resolved)
        if not components:
            continue
        backend, model, hash_id = components
        key = (backend, model, hash_id)
        if key in transcript_records and transcript_records[key].name == "transcript.json":
            continue
        transcript_records[key] = path

    if not transcript_records:
        return False, f"No transcript JSON files found under {transcripts_resolved}", None

    def _has_all_sidecars(base_dir: Path) -> bool:
        return all(
            (base_dir / f"transcript{ext}").exists() for ext in TRANSCRIPT_SIDECAR_EXTENSIONS
        )

    stats: dict[str, dict] = {}
    if catalog_hashes:
        catalog_lower = {h.lower() for h in catalog_hashes}
        for (backend, _model, hash_id), path in transcript_records.items():
            stats.setdefault(
                backend,
                {
                    "_complete": set(),
                    "_incomplete": set(),
                },
            )
            if _has_all_sidecars(path.parent):
                stats[backend]["_complete"].add(hash_id.lower())
            else:
                stats[backend]["_incomplete"].add(hash_id.lower())

        # First pass: transform all backends to final format
        for backend, values in list(stats.items()):
            complete_hashes = set(values.pop("_complete", set()))
            incomplete_hashes = set(values.pop("_incomplete", set()))
            missing = catalog_lower - complete_hashes
            stale = complete_hashes - catalog_lower
            stats[backend] = {
                "total": len(complete_hashes),
                "expected": len(catalog_hashes),
                "missing": len(missing),
                "stale": len(stale),
                "stale_hashes": sorted(stale)[:250],
                "incomplete": len(incomplete_hashes),
                "_complete_hashes": complete_hashes,  # Keep for validation
            }

        # Second pass: check for issues (after all backends are transformed)
        for backend, backend_stats in stats.items():
            missing_count = backend_stats["missing"]
            if missing_count > 0:
                complete_hashes = backend_stats.pop("_complete_hashes")
                # Clean up other backends too
                for other_stats in stats.values():
                    other_stats.pop("_complete_hashes", None)
                overlap = len(catalog_lower & complete_hashes)
                if overlap == 0 and complete_hashes:
                    sample_catalog = _sample_hashes(catalog_hashes)
                    sample_sidecar = _sample_hashes(complete_hashes)
                    example_catalog = sample_catalog[0][:16] + "..." if sample_catalog else "(none)"
                    example_sidecar = sample_sidecar[0][:16] + "..." if sample_sidecar else "(none)"
                    return (
                        False,
                        (
                            f"Transcript exports {backend} have 0 overlap with catalog hashes "
                            f"(likely keyed by a different identity contract). "
                            f"Example catalog={example_catalog}, export={example_sidecar}"
                        ),
                        stats,
                    )
                return (
                    False,
                    f"Transcript exports {backend} missing {missing_count} hashes",
                    stats,
                )

        # Clean up temporary keys
        for backend_stats in stats.values():
            backend_stats.pop("_complete_hashes", None)

    else:
        # Without catalog hashes, ensure at least one complete sidecar exists
        any_complete = any(_has_all_sidecars(path.parent) for path in transcript_records.values())
        if not any_complete:
            return (
                False,
                "No transcript sidecar files found (run `just catalog export-transcripts`)",
                None,
            )

    return True, None, stats


def _extract_num_files_from_clusters(file_path: Path) -> int | None:
    """Extract num_files from clusters JSON without loading entire file.

    Reads only the first few KB to find the metadata.num_files field.
    """
    try:
        # Read just the first 4KB - metadata is at the start
        with file_path.open("r", encoding="utf-8") as f:
            chunk = f.read(4096)

        # Look for "num_files": <number> pattern
        if match := re.search(r'"num_files"\s*:\s*(\d+)', chunk):
            return int(match.group(1))
        return None
    except Exception:
        return None


def require_speaker_clusters(
    transcripts_root: Path,
    clusters_root: Path,
    catalog_hashes: set[str] | None = None,
) -> tuple[bool, str | None, dict | None]:
    """Ensure speaker_clusters exists, is timestamp-aligned, and covers all catalog entries.

    Returns (ok, error_message, stats_dict).
    """
    clusters_resolved = resolve_project_path(clusters_root)

    if not clusters_resolved.exists():
        return False, f"Speaker clusters not found: {clusters_resolved}", None

    try:
        assert_transcripts_speaker_clusters_alignment(transcripts_root, clusters_resolved)
    except RuntimeError as exc:
        return False, str(exc), None

    # Check for cluster files and validate coverage
    stats: dict[str, dict] = {}
    cluster_files = list(clusters_resolved.glob("clusters_*.json"))
    if not cluster_files:
        return False, f"No cluster files found under {clusters_resolved}", None

    if catalog_hashes:
        catalog_lower = {h.lower() for h in catalog_hashes}
        expected_count = len(catalog_hashes)
        for cluster_file in sorted(cluster_files):
            backend = cluster_file.stem.replace("clusters_", "")
            sample_ids = _sample_file_ids_from_clusters(cluster_file)
            sample_overlap = len(sample_ids & catalog_lower) if sample_ids else 0
            # Fast extraction - read only first 4KB instead of entire 1.8GB file
            num_files = _extract_num_files_from_clusters(cluster_file)
            if num_files is None:
                return False, f"Could not read num_files from {cluster_file}", None
            stats[backend] = {
                "total": num_files,
                "expected": expected_count,
                "missing": max(0, expected_count - num_files),
                "sample_overlap": sample_overlap,
            }
            if sample_ids and sample_overlap == 0:
                sample_catalog = _sample_hashes(catalog_hashes)
                example_catalog = sample_catalog[0][:16] + "..." if sample_catalog else "(none)"
                example_cluster = sorted(sample_ids)[0][:16] + "..."
                return (
                    False,
                    (
                        f"Speaker clusters {backend} has 0 overlap with catalog hashes "
                        f"(likely keyed by a different identity contract). "
                        f"Example catalog={example_catalog}, cluster={example_cluster}"
                    ),
                    stats,
                )
            if num_files != expected_count:
                return (
                    False,
                    f"Speaker clusters {backend} has {num_files} files, expected {expected_count}",
                    stats,
                )

    return True, None, stats
