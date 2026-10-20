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
    DEFAULT_TEST_RECORDINGS_PATH,
    TrainingExportError,
    build_dataset,
    fetch_training_export,
    load_test_recordings,
    merge_training_exports,
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

Every staged WAV is hashed and compared with what the web recorded; a changed
file stops the export. Recordings set aside for testing come from
contracts/correction-test-recordings.json unless --test-recordings names
another list. Fetching needs BESEDY_INTERNAL_BASE_URL and
BESEDY_JOB_SERVICE_SECRET in the environment.

The output goes next to the staged audio it is cut from, not into the backed-up
text data: <audio artifacts root>/training/training_export_<timestamp>/ with a
training_export symlink to the latest: audio/*.wav, manifest.jsonl (label,
split and the revision IDs of every chunk), export.json (what the web listed,
including excluded chunks and why) and dataset.json (policy and counts).

Examples:
  catalog training-export --catalog-id 20251222_144441
  catalog training-export --catalog-id 20251222_144441 --audio-hash <hash> --audio-hash <hash>
  catalog training-export --export-json export.json --strip-fillers --test-recordings test.txt
""",
        formatter_class=formatter_class,
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--catalog-id", help="Fetch the export of this catalog from the web application"
    )
    source.add_argument("--export-json", type=Path, help="Use an export saved earlier instead")
    parser.add_argument(
        "--audio-hash",
        action="append",
        default=[],
        metavar="HASH",
        help="Fetch only this recording's workspace; repeat to export a catalog piecewise",
    )
    parser.add_argument(
        "--test-recordings",
        type=Path,
        help=(
            "Audio hashes set aside for testing (JSON list or one per line), never trained on; "
            f"default: {DEFAULT_TEST_RECORDINGS_PATH.name} in the repository's contracts/"
        ),
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
        "--skip-audio-hash",
        action="store_true",
        help="Trust the staged WAVs' size instead of hashing each one",
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


def parse_path_map(items: list[str]) -> dict[str, str]:
    """``FROM=TO`` pairs from ``--map-path``; both sides must be given."""
    mapping: dict[str, str] = {}
    for item in items:
        source, separator, target = item.partition("=")
        if not separator or not source or not target:
            raise ValueError(f"--map-path expects FROM=TO, got {item!r}")
        mapping[source] = target
    return mapping


def handle_training_export(args: argparse.Namespace) -> int:
    try:
        path_map = parse_path_map(args.map_path)
        if args.export_json is not None:
            if args.audio_hash:
                raise ValueError("--audio-hash applies to fetching only, not to --export-json")
            export = json.loads(args.export_json.read_text(encoding="utf-8"))
        elif args.audio_hash:
            export = merge_training_exports(
                [
                    fetch_training_export(
                        args.catalog_id,
                        min_heard_fraction=args.min_heard_fraction,
                        audio_hash=audio_hash,
                    )
                    for audio_hash in args.audio_hash
                ]
            )
        else:
            export = fetch_training_export(
                args.catalog_id, min_heard_fraction=args.min_heard_fraction
            )
        test_recordings_path = (
            args.test_recordings.expanduser()
            if args.test_recordings is not None
            else DEFAULT_TEST_RECORDINGS_PATH
        )
        test_recordings = load_test_recordings(test_recordings_path, str(export.get("catalogId")))

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
            test_recordings=test_recordings,
            test_recordings_source=str(test_recordings_path),
            keep_fillers=not args.strip_fillers,
            verify_audio_hash=not args.skip_audio_hash,
            path_map=path_map,
        )
        if symlink is not None:
            create_or_update_symlink(symlink, output_dir, description="training export")
    except (OSError, ValueError, TrainingExportError, CorrectionManifestError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Dataset: {output_dir}")
    print(json.dumps(summary.to_json(), ensure_ascii=False, indent=2))
    return 0
