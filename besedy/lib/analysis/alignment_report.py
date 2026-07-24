"""Utilities for alignment CLI formatting and defaults."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from besedy.core.paths import resolve_transcripts_root
from besedy.lib.workflow.paths import get_transcript_backend_paths


def _get_default_alignment_pipelines() -> dict[str, Path]:
    """Discover alignment pipelines from on-disk workflow/model directories."""
    transcripts_root = resolve_transcripts_root()
    paths = get_transcript_backend_paths(transcripts_root)
    return {backend_key: transcripts_root / rel_path for backend_key, rel_path in paths.items()}


# Lazy-initialized module-level default (for backward compatibility)
_DEFAULT_ALIGNMENT_PIPELINES: dict[str, Path] | None = None


def _ensure_default_pipelines() -> dict[str, Path]:
    """Ensure DEFAULT_ALIGNMENT_PIPELINES is populated and return it."""
    global _DEFAULT_ALIGNMENT_PIPELINES
    if _DEFAULT_ALIGNMENT_PIPELINES is None:
        _DEFAULT_ALIGNMENT_PIPELINES = _get_default_alignment_pipelines()
    return _DEFAULT_ALIGNMENT_PIPELINES


# Backward compatibility: expose as callable for lazy loading
DEFAULT_ALIGNMENT_PIPELINES = _ensure_default_pipelines


def discover_shared_audio_ids(pipelines: dict[str, Path]) -> list[str]:
    sets = []
    for base in pipelines.values():
        ids = {p.name for p in base.iterdir() if p.is_dir()}
        sets.append(ids)
    shared = set.intersection(*sets) if sets else set()
    return sorted(shared)


def render_alignment_text(report: dict[str, object]) -> str:
    parts: list[str] = []
    ids = report.get("audio_ids_evaluated", [])
    if not isinstance(ids, list):
        ids = []
    parts.append(f"Evaluated {len(ids)} shared audio id(s)")
    parts.append("")

    pair_reports = report.get("pair_reports", [])
    if not isinstance(pair_reports, list):
        pair_reports = []
    for pair in pair_reports:
        if not isinstance(pair, dict):
            continue
        pair = cast(dict[str, Any], pair)
        parts.append(f"{pair['pipeline_a']} ↔ {pair['pipeline_b']}")
        parts.append(
            f"  matched words: {pair['matched_words']} (coverage: {pair['coverage_a']:.1f}%/{pair['coverage_b']:.1f}%)"
        )
        parts.append(f"  text agreement: {pair['text_match_ratio']:.1f}%")
        start = pair["start_diff"]
        parts.append(
            f"  start diff mean={start['mean']:.3f}s median={start['median']:.3f}s p95={start['p95']:.3f}s"
        )
        if pair["per_audio_offset_range"]:
            rng = pair["per_audio_offset_range"]
            parts.append(f"  per-audio offset range: {rng['min']:+.3f}s → {rng['max']:+.3f}s")
        overlap = pair.get("overlap", {})
        parts.append(f"  overlap duration: {overlap.get('duration', 0.0):.2f}s")
        if pair.get("best_offset"):
            best = pair["best_offset"]
            parts.append(f"  suggested shift for {pair['pipeline_b']}: {best['offset']:+.3f}s")
        parts.append("")

    parts.append("Confidence summaries:")
    confidence_summary = report.get("confidence_summary", {})
    if not isinstance(confidence_summary, dict):
        confidence_summary = {}
    for name, summary in confidence_summary.items():
        if not isinstance(summary, dict):
            continue
        summary = cast(dict[str, Any], summary)
        parts.append(
            f"  {name}: mean={summary['mean']:.3f}, median={summary['median']:.3f}, coverage={summary['count']}"
        )
    parts.append("")
    parts.append("Word duration summaries:")
    word_duration_summary = report.get("word_duration_summary", {})
    if not isinstance(word_duration_summary, dict):
        word_duration_summary = {}
    for name, summary in word_duration_summary.items():
        if not isinstance(summary, dict):
            continue
        summary = cast(dict[str, Any], summary)
        parts.append(
            f"  {name}: mean={summary['mean']:.3f}s median={summary['median']:.3f}s p95={summary['p95']:.3f}s"
        )
    return "\n".join(parts)


__all__ = [
    "DEFAULT_ALIGNMENT_PIPELINES",
    "discover_shared_audio_ids",
    "render_alignment_text",
]
