#!/usr/bin/env python3
"""ColBERT sidecar retrieval evaluation helper."""

from __future__ import annotations

import argparse
import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from besedy.lib.rag_colbert import (
    query_colbert_index,
    validate_chunk_target_ids_against_manifest,
)
from besedy.lib.rag_eval_records import (
    EvalTarget,
    load_eval_records,
    parse_eval_targets,
    record_query,
)
from tests._rag_eval_support import load_index_meta


def evaluate_colbert_recall(
    *,
    questions_path: Path | str,
    index_dir: Path | str,
    k: int = 10,
    cutoffs: Sequence[int] | None = None,
    force_fast: bool = False,
    include_hit_details: bool = False,
) -> dict[str, Any]:
    """Evaluate recall@k for a ColBERT sidecar index."""

    recall_cutoffs = _normalize_cutoffs(k=k, cutoffs=cutoffs)
    query_k = max(recall_cutoffs)
    records = load_eval_records(questions_path)
    validate_chunk_target_ids_against_manifest(index_dir=index_dir, records=records)

    meta = load_index_meta(index_dir)
    total = 0
    target_hits_by_cutoff = dict.fromkeys(recall_cutoffs, 0)
    audio_hits_by_cutoff = dict.fromkeys(recall_cutoffs, 0)
    reciprocal_rank_by_cutoff = dict.fromkeys(recall_cutoffs, 0.0)
    audio_only_misses_by_cutoff = dict.fromkeys(recall_cutoffs, 0)
    details: list[dict[str, Any]] = []
    audio_total = 0

    for record in records:
        question = record_query(record)
        if not question:
            continue
        targets = parse_eval_targets(record)
        if not targets:
            continue
        audio_targets = [target for target in targets if target.audio_hash is not None]

        total += 1
        if audio_targets:
            audio_total += 1
        result = query_colbert_index(
            query=question,
            index_dir=index_dir,
            k=query_k,
            force_fast=force_fast,
        )

        target_match = _first_matching_hit(
            result.hits,
            targets,
            matcher=_target_matches_hit,
        )
        audio_match = _first_matching_hit(
            result.hits,
            audio_targets,
            matcher=_target_audio_matches_hit,
        )

        for cutoff in recall_cutoffs:
            target_matched = _hit_is_within_cutoff(target_match, cutoff)
            audio_matched = _hit_is_within_cutoff(audio_match, cutoff)
            if target_matched:
                target_hits_by_cutoff[cutoff] += 1
                reciprocal_rank_by_cutoff[cutoff] += 1.0 / target_match.rank
            if audio_matched:
                audio_hits_by_cutoff[cutoff] += 1
            if audio_matched and not target_matched:
                audio_only_misses_by_cutoff[cutoff] += 1

        matches_at_cutoff = [
            _detail_match_at_cutoff(
                cutoff=cutoff,
                target_match=target_match,
                audio_match=audio_match,
            )
            for cutoff in recall_cutoffs
        ]
        primary_match = next(match for match in matches_at_cutoff if match["cutoff"] == k)
        detail = {
            "id": record.get("id"),
            "category": record.get("category"),
            "question": question,
            "matched": primary_match["matched"],
            "match_rank": target_match.rank if target_match is not None else None,
            "matched_chunk_id": target_match.chunk_id if target_match is not None else None,
            "audio_match_rank": audio_match.rank if audio_match is not None else None,
            "audio_matched_chunk_id": audio_match.chunk_id if audio_match is not None else None,
            "audio_only_miss": primary_match["audio_only_miss"],
            "matches_at_cutoff": matches_at_cutoff,
            "returned_chunk_ids": [hit.chunk_id for hit in result.hits],
        }
        if include_hit_details:
            detail["returned_hits"] = [_serialize_hit(hit) for hit in result.hits]
        details.append(detail)

    metrics_at_cutoff = [
        {
            "cutoff": cutoff,
            "hits": target_hits_by_cutoff[cutoff],
            "recall": (target_hits_by_cutoff[cutoff] / total) if total else 0.0,
            "audio_hits": audio_hits_by_cutoff[cutoff],
            "audio_total": audio_total,
            "audio_recall": ((audio_hits_by_cutoff[cutoff] / audio_total) if audio_total else 0.0),
            "mrr": ((reciprocal_rank_by_cutoff[cutoff] / total) if total else 0.0),
            "audio_only_misses": audio_only_misses_by_cutoff[cutoff],
        }
        for cutoff in recall_cutoffs
    ]
    primary_cutoff = k
    primary_metrics = next(
        metrics for metrics in metrics_at_cutoff if metrics["cutoff"] == primary_cutoff
    )
    return {
        "mode": "colbert_only",
        "workflow_group_id": str(meta["workflow_group_id"]),
        "backend_key": str(meta["backend_key"]),
        "index_dir": str(index_dir),
        "colbert_model": str(meta["colbert_model"]),
        "doc_maxlen": int(meta["doc_maxlen"]),
        "chunk_version": str(meta["chunk_version"]),
        "run_id": str(meta["run_id"]),
        "force_fast": force_fast,
        "k": primary_cutoff,
        "cutoffs": list(recall_cutoffs),
        "total": total,
        "audio_total": audio_total,
        "hits": primary_metrics["hits"],
        "recall_at_k": primary_metrics["recall"],
        "audio_only_misses": primary_metrics["audio_only_misses"],
        "metrics_at_cutoff": metrics_at_cutoff,
        "details": details,
    }


def _normalize_cutoffs(*, k: int, cutoffs: Sequence[int] | None) -> tuple[int, ...]:
    values = (k, *(cutoffs or ()))
    if any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in values):
        raise ValueError("Recall cutoffs must be positive.")
    return tuple(sorted(set(values)))


def _first_matching_hit(
    hits: Sequence[Any],
    targets: Sequence[EvalTarget],
    *,
    matcher: Callable[[Any, EvalTarget], bool],
) -> Any | None:
    for hit in hits:
        if any(matcher(hit, target) for target in targets):
            return hit
    return None


def _target_matches_hit(hit: Any, target: EvalTarget) -> bool:
    return target.matches(
        chunk_id=hit.chunk_id,
        audio_hash=hit.audio_hash,
        start_sec=hit.start_sec,
        end_sec=hit.end_sec,
    )


def _target_audio_matches_hit(hit: Any, target: EvalTarget) -> bool:
    return target.matches_audio(hit.audio_hash)


def _hit_is_within_cutoff(hit: Any | None, cutoff: int) -> bool:
    return hit is not None and hit.rank <= cutoff


def _detail_match_at_cutoff(
    *,
    cutoff: int,
    target_match: Any | None,
    audio_match: Any | None,
) -> dict[str, Any]:
    matched = _hit_is_within_cutoff(target_match, cutoff)
    audio_matched = _hit_is_within_cutoff(audio_match, cutoff)
    return {
        "cutoff": cutoff,
        "matched": matched,
        "audio_matched": audio_matched,
        "audio_only_miss": audio_matched and not matched,
    }


def _serialize_hit(hit: Any) -> dict[str, Any]:
    return {
        "rank": hit.rank,
        "chunk_id": hit.chunk_id,
        "audio_hash": hit.audio_hash,
        "start_sec": hit.start_sec,
        "end_sec": hit.end_sec,
        "score": hit.score,
        "chunk_ordinal": hit.chunk_ordinal,
        "text": hit.text,
    }


def _positive_int(raw_value: str) -> int:
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--questions", type=Path, required=True, help="Path to JSON eval records.")
    parser.add_argument(
        "--index-dir", type=Path, required=True, help="ColBERT sidecar index directory."
    )
    parser.add_argument("--k", type=_positive_int, default=10, help="Primary Recall@k cutoff.")
    parser.add_argument(
        "--cutoffs",
        type=_positive_int,
        nargs="+",
        help=(
            "Additional recall cutoffs to report; --k is always included. "
            "The index is queried once at the largest cutoff, so lower-cutoff "
            "results may differ from standalone runs on the Stanford PLAID backend."
        ),
    )
    parser.add_argument(
        "--force-fast", action="store_true", help="Forward force_fast to ColBERT search."
    )
    parser.add_argument(
        "--include-hit-details",
        action="store_true",
        help="Include full returned hit text and scores in JSON details.",
    )
    parser.add_argument(
        "--details-path",
        type=Path,
        help="Optional path for the full JSON result, useful for candidate inspection.",
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = evaluate_colbert_recall(
        questions_path=args.questions,
        index_dir=args.index_dir,
        k=args.k,
        cutoffs=args.cutoffs,
        force_fast=args.force_fast,
        include_hit_details=args.include_hit_details,
    )
    if args.details_path is not None:
        args.details_path.parent.mkdir(parents=True, exist_ok=True)
        args.details_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("ColBERT retrieval eval")
        print(f"  workflow_group_id: {result['workflow_group_id']}")
        print(f"  backend_key: {result['backend_key']}")
        print(f"  colbert_model: {result['colbert_model']}")
        print(f"  total: {result['total']}")
        print(f"  audio_total: {result['audio_total']}")
        print(f"  hits@{result['k']}: {result['hits']}")
        for metrics in result["metrics_at_cutoff"]:
            print(
                f"  recall@{metrics['cutoff']}: {metrics['recall']:.4f} "
                f"(audio@{metrics['cutoff']}: {metrics['audio_recall']:.4f}, "
                f"mrr@{metrics['cutoff']}: {metrics['mrr']:.4f}, "
                f"audio_only_misses: {metrics['audio_only_misses']})"
            )
        if args.details_path is not None:
            print(f"  details_path: {args.details_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
