"""Audio staging command."""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

from besedy.commands.catalog.csv_utils import load_audio_rows, resolve_catalog_csv
from besedy.commands.catalog.default_paths import (
    get_default_loudness_symlink,
    get_default_normalized_symlink,
)
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.commands.catalog.ui import has_error_skips, print_workflow_summary
from besedy.core.paths import (
    extract_timestamp_from_loudness_catalog,
    resolve_audio_artifacts_root,
)
from besedy.lib.audio.normalize import stage_audio_files
from besedy.lib.audio.types import ManifestWriter


@dataclass
class StageAudioRequest:
    csv: Path | None = None
    output_dir: Path | None = None
    overwrite: bool = False
    skip_audio_analysis: bool = False
    no_aggressive_normalization: bool = False
    continue_on_error: bool = False
    verbose: bool = False
    limit: int | None = None
    ffprobe_binary: Path | str = "ffprobe"
    ffmpeg_binary: Path | str = "ffmpeg"
    no_symlink: bool = False

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "StageAudioRequest",
    ) -> "StageAudioRequest":
        if isinstance(args, cls):
            return args
        return cls(
            csv=getattr(args, "csv", None),
            output_dir=getattr(args, "output_dir", None),
            overwrite=bool(getattr(args, "overwrite", False)),
            skip_audio_analysis=bool(getattr(args, "skip_audio_analysis", False)),
            no_aggressive_normalization=bool(getattr(args, "no_aggressive_normalization", False)),
            continue_on_error=bool(getattr(args, "continue_on_error", False)),
            verbose=bool(getattr(args, "verbose", False)),
            limit=getattr(args, "limit", None),
            ffprobe_binary=getattr(args, "ffprobe_binary", "ffprobe"),
            ffmpeg_binary=getattr(args, "ffmpeg_binary", "ffmpeg"),
            no_symlink=bool(getattr(args, "no_symlink", False)),
        )


def infer_staging_dir_from_normalized_csv(csv_path: Path) -> tuple[Path | None, str | None]:
    """Infer staging directory from an existing normalized catalog CSV.

    Rules:
    - All files must have the same parent directory
    - The directory must contain only files (no subdirectories)

    Args:
        csv_path: Path to the normalized catalog CSV.

    Returns:
        Tuple of (staging_dir, error_message). If successful, error is None.
    """
    if not csv_path.exists():
        return None, None  # No existing CSV, not an error

    try:
        with csv_path.open("r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if "Full Path" not in (reader.fieldnames or []):
                return None, f"Normalized CSV missing 'Full Path' column: {csv_path}"

            parents = set()
            for row in reader:
                full_path = row.get("Full Path", "").strip()
                if full_path:
                    parents.add(Path(full_path).parent)

    except Exception as exc:
        return None, f"Failed to read normalized CSV {csv_path}: {exc}"

    if not parents:
        return None, f"No file paths found in normalized CSV: {csv_path}"

    if len(parents) > 1:
        return None, (
            f"Staging directory cannot be inferred: files in normalized CSV "
            f"have different parent directories ({len(parents)} found)"
        )

    staging_dir = parents.pop()

    if not staging_dir.exists():
        return None, f"Inferred staging directory does not exist: {staging_dir}"

    # Check that directory contains only files, no subdirectories
    for item in staging_dir.iterdir():
        if item.is_dir():
            return None, (
                f"Staging directory contains subdirectories, which is not allowed: "
                f"{staging_dir} (found: {item.name})"
            )

    return staging_dir, None


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'stage-audio' subparser."""
    parser = subparsers.add_parser(
        "stage-audio",
        help="Convert and normalize audio to 16 kHz mono WAV",
        description="""\
Combines loudness normalization and format conversion into a single step.

Requires loudness analysis first: run 'catalog loudness' before this command.

Example:
  catalog loudness                # Step 1: analyze
  catalog stage-audio             # Step 2: normalize and convert
  catalog stage-audio --limit 10  # Process only first 10 files
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Input catalog with loudness data. Default: audio_catalog_loudness.csv symlink (created by 'catalog loudness').",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory. Default: <audio_artifacts_root>/audio_staged_<timestamp>/.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Force re-staging of all files, even if they already exist.",
    )
    parser.add_argument(
        "--skip-audio-analysis",
        action="store_true",
        help="Skip verification of staged files after conversion. Faster but won't detect conversion errors.",
    )
    parser.add_argument(
        "--no-aggressive-normalization",
        action="store_true",
        help="Disable compression fallback. By default, if simple gain adjustment can't reach target loudness, dynamic range compression is applied. This flag forces linear-only normalization.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Skip problematic files instead of aborting the entire run.",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Show each file as it's processed (reused, converted, skipped, etc.).",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Process only the first N files. Useful for testing pipeline on a subset.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        default="ffprobe",
        help="Path to ffprobe executable.",
    )
    parser.add_argument(
        "--ffmpeg-binary",
        default="ffmpeg",
        help="Path to ffmpeg executable.",
    )
    parser.add_argument(
        "--no-symlink",
        action="store_true",
        help="Do not create or update symlinks (normalized catalog or staged audio).",
    )
    parser.set_defaults(func=handle_stage_audio)
    return parser


def handle_stage_audio(
    args: argparse.Namespace | StageAudioRequest,
) -> int:
    """Normalize and stage audio files for transcription."""
    request = StageAudioRequest.from_args(args)

    try:
        csv_path = resolve_catalog_csv(
            request.csv,
            purpose="stage-audio",
            default_symlink=get_default_loudness_symlink(),
        )
    except FileNotFoundError as exc:
        # Provide helpful error message about running catalog loudness first
        if request.csv is None:
            print(
                f"Error: {exc}\n\n"
                "Run 'catalog loudness' first to analyze audio files.\n\n"
                "Example workflow:\n"
                "  catalog create /path/to/audio     # Fast: create basic catalog\n"
                "  catalog loudness                  # Analyze loudness for normalization\n"
                "  catalog stage-audio               # Normalize and stage audio",
                file=sys.stderr,
            )
        else:
            print(exc, file=sys.stderr)
        return 1

    try:
        rows = load_audio_rows(csv_path, require_duration=True, limit=request.limit)
    except ValueError as exc:
        print(f"Error while reading {csv_path}: {exc}", file=sys.stderr)
        return 1

    if not rows:
        print(f"No rows found in {csv_path}.")
        return 0

    # Pre-flight validation: determine if we'll need symlink and validate upfront
    normalized_csv_path = csv_path.with_name(f"{csv_path.stem}_normalized.csv")
    normalized_symlink = get_default_normalized_symlink()
    need_symlink = not request.no_symlink and normalized_csv_path != normalized_symlink

    if need_symlink:
        try:
            validate_symlink_can_be_created(normalized_symlink, description="normalized catalog")
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Extract timestamp from source catalog (preserves pipeline coherence)
    timestamp = extract_timestamp_from_loudness_catalog(csv_path.resolve())
    if not timestamp:
        print(
            f"Error: Loudness catalog '{csv_path.name}' lacks timestamp in filename.\n"
            "Expected format: audio_catalog_YYYYMMDD_HHMMSS_loudness.csv\n"
            "Run 'catalog loudness' with a properly timestamped catalog.",
            file=sys.stderr,
        )
        return 1

    # Use explicit output_dir, existing symlink target, or create timestamped dir
    artifacts_root = resolve_audio_artifacts_root()
    staging_symlink = artifacts_root / "audio_staged"
    expected_staging_dir = artifacts_root / f"audio_staged_{timestamp}"

    if request.output_dir is not None:
        # Explicit output dir provided
        staging_dir = request.output_dir.expanduser()
    elif (
        not request.no_symlink
        and staging_symlink.is_symlink()
        and staging_symlink.resolve().is_dir()
    ):
        # Reuse existing staging directory from symlink (incremental mode)
        staging_dir = staging_symlink.resolve()
        print(f"Reusing existing staging directory: {staging_dir}")
    else:
        # Create new timestamped directory (using source catalog timestamp)
        staging_dir = expected_staging_dir

    # Validate symlink can be created upfront (only if we need to update it)
    if not request.no_symlink and (
        not staging_symlink.is_symlink() or staging_symlink.resolve() != staging_dir
    ):
        try:
            validate_symlink_can_be_created(staging_symlink, description="staged audio")
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    overwrite = request.overwrite
    reuse_existing = staging_dir.exists() and not overwrite
    if overwrite and staging_dir.exists():
        print(f"Overwrite mode: re-staging all files in {staging_dir}")
    elif reuse_existing:
        print(f"Reusing existing staging directory: {staging_dir}")
    else:
        staging_dir.mkdir(parents=True, exist_ok=True)
        print(f"Created staging directory: {staging_dir}")

    include_analysis = not request.skip_audio_analysis
    manifest_writer = ManifestWriter(
        normalized_csv_path,
        include_analysis=include_analysis,
    )

    # Create symlinks immediately (point to "current data set")
    if need_symlink:
        create_or_update_symlink(
            normalized_symlink, normalized_csv_path, description="normalized catalog"
        )
    if not request.no_symlink and staging_symlink is not None:
        create_or_update_symlink(staging_symlink, staging_dir, description="staged audio")

    try:
        prepared, skipped = stage_audio_files(
            rows,
            staging_dir,
            manifest_writer=manifest_writer,
            include_audio_analysis=include_analysis,
            analysis_ffmpeg=str(request.ffmpeg_binary),
            analysis_ffprobe=str(request.ffprobe_binary),
            continue_on_error=request.continue_on_error,
            reuse_existing=reuse_existing,
            aggressive_normalization=not request.no_aggressive_normalization,
            verbose=request.verbose,
        )
    except RuntimeError as exc:
        print(f"Error while staging audio: {exc}", file=sys.stderr)
        return 1
    finally:
        manifest_writer.close()

    print(f"Wrote staged manifest CSV to {normalized_csv_path}")
    print(f"Staged audio directory: {staging_dir}")

    print_workflow_summary(prepared, skipped, [])

    return 1 if has_error_skips(skipped) else 0
