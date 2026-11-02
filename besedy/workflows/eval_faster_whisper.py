#!/usr/bin/env python3
"""Score a CTranslate2 Whisper model on a training dataset through the production decode path.

Runs inside the faster-whisper image, started by ``catalog training-eval``.
Every chunk WAV of the chosen split is transcribed with
``BatchedInferencePipeline`` and exactly the options
``transcribe_faster_whisper.py`` uses, so the fine-tuned model and the
production model are compared the way production will run them. Scores use
the shared normalizer in ``besedy/lib/asr_evaluation.py``.
"""

from __future__ import annotations

import argparse
import json
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import ctranslate2
import faster_whisper
from faster_whisper import BatchedInferencePipeline, WhisperModel
from faster_whisper.utils import download_model
from tqdm.auto import tqdm

from besedy.lib import asr_evaluation as ev
from besedy.lib.catalog.manager import source_file_sha256
from besedy.lib.workflow.config import select_transcription_workflow
from besedy.lib.workflow.faster_whisper_options import production_transcribe_options
from besedy.lib.workflow.language import resolve_inference_language, resolve_language_setting
from besedy.workflows.transcribe_faster_whisper import resolve_model_reference


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, required=True, help="Dataset directory")
    parser.add_argument("--out", type=Path, required=True, help="Report directory")
    parser.add_argument("--model", required=True, help="CTranslate2 model directory or alias")
    parser.add_argument("--label", default=None, help="Name of the system in the report")
    parser.add_argument("--split", default="test")
    parser.add_argument("--recordings", type=Path, default=None, help="Audio hashes to keep")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--language", default=None)
    parser.add_argument("--git-commit", default=None)
    return parser.parse_args()


def describe_model(reference: str, resolved: str) -> dict[str, Any]:
    """Where the weights came from and the hash of model.bin, for the report."""
    model_dir = Path(resolved) if Path(resolved).is_dir() else Path(download_model(resolved))
    model_bin = model_dir / "model.bin"
    description: dict[str, Any] = {"reference": reference, "path": str(model_dir)}
    if model_bin.is_file():
        description["model_bin_bytes"] = model_bin.stat().st_size
        description["model_bin_sha256"] = source_file_sha256(model_bin)
    return description


def transcribe_rows(
    pipeline: BatchedInferencePipeline,
    data_dir: Path,
    rows: Sequence[Mapping[str, Any]],
    options: Mapping[str, Any],
) -> list[str]:
    hyps: list[str] = []
    for row in tqdm(rows, desc="Scoring chunks", unit="chunk", ncols=100):
        segments, _info = pipeline.transcribe(str(data_dir / row["audio"]), **options)
        parts = [(getattr(seg, "text", "") or "").strip() for seg in segments]
        hyps.append(" ".join(part for part in parts if part).strip())
    return hyps


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    workflow = select_transcription_workflow("faster-whisper", language=args.language)
    language_setting = resolve_language_setting(args.language, workflow.language)
    language = resolve_inference_language(language_setting)
    options = production_transcribe_options(language=language, batch_size=args.batch_size)
    options.pop("log_progress", None)

    recordings = ev.load_recordings(args.recordings) if args.recordings else None
    rows = ev.select_rows(ev.load_manifest(args.data), args.split, recordings)
    if not rows:
        raise SystemExit(f"No {args.split} rows in {args.data / 'manifest.jsonl'}")

    resolved = resolve_model_reference(args.model)
    logging.info("Loading %s on %s (%s)", resolved, args.device, args.compute_type)
    model = WhisperModel(resolved, device=args.device, compute_type=args.compute_type)
    pipeline = BatchedInferencePipeline(model=model)
    hyps = transcribe_rows(pipeline, args.data, rows, options)
    scores = ev.score_rows(rows, hyps)

    label = args.label or args.model
    report = ev.build_report(
        system=label,
        dataset=ev.dataset_identity(args.data),
        split=args.split,
        rows=rows,
        scores=scores,
        model={
            **describe_model(args.model, resolved),
            "device": args.device,
            "compute_type": args.compute_type,
        },
        options={
            **options,
            "language_setting": language_setting,
            "decode": "faster-whisper batched",
        },
        git_commit=args.git_commit,
        versions={
            "faster_whisper": faster_whisper.__version__,
            "ctranslate2": ctranslate2.__version__,
        },
        recordings_source=str(args.recordings) if args.recordings else None,
    )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    ev.write_hypotheses(args.out / "hypotheses.jsonl", scores)
    print(ev.comparison_table([report]))
    print(f"Report: {args.out / 'report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
