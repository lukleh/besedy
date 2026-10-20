"""Build a training dataset from human transcript corrections (ADR 0012)."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from besedy.core.paths_runtime import resolve_audio_artifacts_root, resolve_corrections_root
from besedy.core.symlinks import create_or_update_symlink
from besedy.lib.correction_guard import CorrectionManifestError
from besedy.lib.correction_training import (
    TrainingExportError,
    build_dataset,
    fetch_training_export,
    load_test_recordings,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'training-export' subparser."""
    parser = subparsers.add_parser(
        "training-export",
        help="Build a training dataset from corrected transcripts",
        description="""\
Asks the web application which corrected chunks may train a model, rebuilds
each one exactly as the model was given it (its VAD regions concatenated from
the staged WAV) and writes it with its corrected text as the label.

The output goes next to the staged audio it is cut from, not into the backed-up
text data: <audio artifacts root>/training/training_export_<timestamp>/ with a
training_export symlink to the latest: audio/*.wav, manifest.jsonl (label,
split and the revision IDs of every chunk), export.json (what the web listed,
including excluded chunks and why) and dataset.json (policy and counts).

Examples:
  catalog training-export --catalog-id 20251222_144441 --test-recordings test.txt
  catalog training-export --export-json export.json --strip-fillers
""",
        formatter_class=formatter_class,
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--catalog-id", help="Fetch the export of this catalog from the web application"
    )
    source.add_argument("--export-json", type=Path, help="Use an export saved earlier instead")
    parser.add_argument(
        "--test-recordings",
        type=Path,
        help="Audio hashes set aside for testing (JSON list or one per line); never trained on",
    )
    parser.add_argument(
        "--strip-fillers", action="store_true", help="Remove ehm/eee/hm/mhm from labels"
    )
    parser.add_argument(
        "--min-heard-fraction",
        type=float,
        default=None,
        help="Share of a span an approver must have heard (web default 0.9)",
    )
    parser.add_argument(
        "--verify-audio-hash", action="store_true", help="Check each staged WAV's SHA-256"
    )
    parser.add_argument("--corrections-root", type=Path, default=None)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Default: timestamped under the audio artifacts root",
    )
    parser.add_argument(
        "--map-path",
        action="append",
        default=[],
        metavar="FROM=TO",
        help="Read staged audio recorded under FROM from TO (for test environments)",
    )
    parser.set_defaults(func=handle_training_export)
    return parser


def handle_training_export(args: argparse.Namespace) -> int:
    try:
        if args.export_json is not None:
            export = json.loads(args.export_json.read_text(encoding="utf-8"))
        else:
            export = fetch_training_export(
                args.catalog_id, min_heard_fraction=args.min_heard_fraction
            )

        if args.output_dir is not None:
            output_dir = args.output_dir.expanduser()
            symlink = None
        else:
            base = resolve_audio_artifacts_root() / "training"
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_dir = base / f"training_export_{stamp}"
            symlink = base / "training_export"
        output_dir.mkdir(parents=True, exist_ok=False)

        summary = build_dataset(
            export,
            resolve_corrections_root(args.corrections_root),
            output_dir,
            test_recordings=load_test_recordings(args.test_recordings),
            keep_fillers=not args.strip_fillers,
            verify_audio_hash=args.verify_audio_hash,
            path_map=dict(item.split("=", 1) for item in args.map_path),
        )
        if symlink is not None:
            create_or_update_symlink(symlink, output_dir, description="training export")
    except (OSError, ValueError, TrainingExportError, CorrectionManifestError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Dataset: {output_dir}")
    print(json.dumps(summary.to_json(), ensure_ascii=False, indent=2))
    return 0
