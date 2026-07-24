"""Catalog join command - concatenate multiple audio files.

This module provides the handler for `catalog join`, which:
- Probes source audio files for properties and metadata
- Determines optimal join strategy (stream copy vs reencode)
- Applies 1-second fade transitions by default
- Tracks joined files in a separate _joined CSV catalog
"""

from __future__ import annotations

import argparse
import csv
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import TextIO, cast

from besedy.commands.catalog.default_paths import (
    get_default_catalog_symlink,
    get_default_duplicates_symlink,
    get_default_joined_symlink,
)
from besedy.commands.catalog.join_paths import (
    AudioFileLike,
    _check_duplicate_join_in_catalog,
    _load_catalog_paths_for_hashes,
    _load_duplicate_paths,
    _load_scan_roots_from_catalog,
    _load_sidecar_paths_for_hashes,
    _move_duplicate_paths,
    _move_originals,
    _normalize_path_nfc,
    _plan_original_moves,  # noqa: F401
)
from besedy.commands.catalog.symlink import (
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.core.paths import (
    extract_timestamp_from_catalog,
    resolve_catalogs_root,
    resolve_joined_audio_root,
    resolve_original_audio_root,
)
from besedy.lib.audio.join import (
    CODEC_TO_FORMAT,
    FORMAT_EXTENSIONS,
    AudioFileInfo,
    JoinMetadata,
    JoinStrategy,
    build_reencode_command,
    build_stream_copy_command,
    determine_join_strategy,
    format_duration,
    format_size,
    probe_audio_file,
    resolve_join_metadata,
)
from besedy.lib.catalog.manager import audio_content_sha256sum

# Normalize format names for comparison (aac and m4a are the same container)
_FORMAT_CANONICAL = {"aac": "m4a"}


def _normalize_format(fmt: str | None) -> str | None:
    """Normalize format name to canonical form for comparison."""
    if fmt is None:
        return None
    return _FORMAT_CANONICAL.get(fmt.lower(), fmt.lower())


# CSV column names for joined catalog
JOINED_CSV_COLUMNS = [
    # Source columns
    "Source Order",
    "Source Hash",
    "Source Filename",
    "Source Path",
    "Source Duration",
    "Source Duration (s)",
    "Source Format",
    "Source Sample Rate",
    "Source Channels",
    "Source Bitrate (kbps)",
    "Source Title",
    "Source Artist",
    "Source Album",
    "Source Date",
    # Output columns
    "Output Hash",
    "Output Filename",
    "Output Path",
    "Output Duration",
    "Output Duration (s)",
    "Output Format",
    "Output Sample Rate",
    "Output Channels",
    "Output Bitrate (kbps)",
    "Output Title",
    "Output Artist",
    "Output Album",
    "Output Comment",
    # Join metadata
    "Source Count",
    "Strategy",
    "Fades",
    "added_at",
]


def _get_catalog_timestamp() -> str:
    """Get timestamp from current catalog pipeline, or generate new one."""
    catalog_symlink = get_default_catalog_symlink()
    if catalog_symlink.exists() or catalog_symlink.is_symlink():
        catalog_path = catalog_symlink.resolve()
        ts = extract_timestamp_from_catalog(catalog_path)
        if ts:
            return ts
    # Fallback to current timestamp
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _codec_to_format(codec: str) -> str:
    """Map codec name to format string for CSV."""
    mapping = {
        "mp3": "mp3",
        "aac": "m4a",
        "opus": "opus",
        "vorbis": "ogg",
        "flac": "flac",
        "pcm_s16le": "wav",
        "pcm_s24le": "wav",
        "pcm_s32le": "wav",
    }
    return mapping.get(codec, codec)


class JoinedManifestWriter:
    """Thread-safe CSV writer for joined audio manifest."""

    def __init__(self, csv_path: Path) -> None:
        self.csv_path = csv_path
        self._file: TextIO | None = None
        self._writer: csv.DictWriter | None = None
        self._is_new_file = not csv_path.exists()

    def __enter__(self) -> "JoinedManifestWriter":
        self._file = open(self.csv_path, "a", newline="", encoding="utf-8")
        self._writer = csv.DictWriter(self._file, fieldnames=JOINED_CSV_COLUMNS)
        if self._is_new_file:
            self._writer.writeheader()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        if self._file:
            self._file.close()

    def write_entry(
        self,
        source_order: int,
        source: AudioFileInfo,
        source_hash: str,
        output_path: Path,
        output_hash: str,
        output_duration_seconds: float,
        strategy: JoinStrategy,
        metadata: JoinMetadata,
        source_count: int,
    ) -> None:
        """Write a single source file row to the CSV."""
        if not self._writer:
            raise RuntimeError("Writer not initialized")

        row = {
            # Source columns
            "Source Order": source_order,
            "Source Hash": source_hash,
            "Source Filename": source.path.name,
            "Source Path": str(source.path),
            "Source Duration": format_duration(source.duration_seconds),
            "Source Duration (s)": f"{source.duration_seconds:.3f}",
            "Source Format": _codec_to_format(source.codec),
            "Source Sample Rate": source.sample_rate,
            "Source Channels": source.channels,
            "Source Bitrate (kbps)": source.bitrate_kbps or "",
            "Source Title": source.title or "",
            "Source Artist": source.artist or "",
            "Source Album": source.album or "",
            "Source Date": source.date or "",
            # Output columns
            "Output Hash": output_hash,
            "Output Filename": output_path.name,
            "Output Path": str(output_path),
            "Output Duration": format_duration(output_duration_seconds),
            "Output Duration (s)": f"{output_duration_seconds:.3f}",
            "Output Format": strategy.output_format,
            "Output Sample Rate": strategy.sample_rate,
            "Output Channels": strategy.channels,
            "Output Bitrate (kbps)": strategy.bitrate_kbps,
            "Output Title": metadata.title or "",
            "Output Artist": metadata.artist or "",
            "Output Album": metadata.album or "",
            "Output Comment": metadata.comment,
            # Join metadata
            "Source Count": source_count,
            "Strategy": strategy.method,
            "Fades": "1s" if strategy.use_fades else "none",
            "added_at": datetime.now().isoformat(),
        }
        self._writer.writerow(row)
        if self._file:
            self._file.flush()


def _print_analysis_table(
    files: list[AudioFileInfo],
    strategy: JoinStrategy,
    output_path: Path | None = None,
) -> None:
    """Print analysis table showing file properties and strategy."""
    try:
        from rich.console import Console
        from rich.table import Table

        console = Console()

        # File properties table
        table = Table(title="Audio File Analysis")
        table.add_column("File", style="cyan")
        table.add_column("Format", style="magenta")
        table.add_column("Rate", justify="right")
        table.add_column("Ch", justify="center")
        table.add_column("Bitrate", justify="right")
        table.add_column("Duration", justify="right")
        table.add_column("Title")

        for f in files:
            table.add_row(
                f.path.name,
                _codec_to_format(f.codec).upper(),
                f"{f.sample_rate} Hz",
                str(f.channels),
                f"{f.bitrate_kbps}k" if f.bitrate_kbps else "N/A",
                format_duration(f.duration_seconds),
                f.title or "",
            )

        console.print(table)
        console.print()

        # Strategy summary
        total_duration = sum(f.duration_seconds for f in files)
        console.print(f"[bold]Strategy:[/bold] {strategy.method.upper()}")
        console.print(f"  Output format:  {strategy.output_format}")
        console.print(f"  Sample rate:    {strategy.sample_rate} Hz")
        console.print(f"  Channels:       {strategy.channels}")
        console.print(f"  Bitrate:        {strategy.bitrate_kbps} kbps")
        console.print(f"  Fades:          {'1s in/out' if strategy.use_fades else 'none'}")
        console.print(f"  Total duration: {format_duration(total_duration)}")

        if output_path:
            console.print(f"\n[bold]Output:[/bold] {output_path}")

    except ImportError:
        # Fallback to plain text
        print("\nAudio File Analysis")
        print("-" * 80)
        print(f"{'File':<30} {'Format':<8} {'Rate':<10} {'Ch':<4} {'Bitrate':<10} {'Duration':<10}")
        print("-" * 80)
        for f in files:
            print(
                f"{f.path.name:<30} "
                f"{_codec_to_format(f.codec).upper():<8} "
                f"{f.sample_rate} Hz{'':<4} "
                f"{f.channels:<4} "
                f"{f.bitrate_kbps or 'N/A':<10} "
                f"{format_duration(f.duration_seconds):<10}"
            )
        print("-" * 80)
        print(f"\nStrategy: {strategy.method.upper()}")
        print(f"  Output format:  {strategy.output_format}")
        print(f"  Sample rate:    {strategy.sample_rate} Hz")
        print(f"  Channels:       {strategy.channels}")
        print(f"  Bitrate:        {strategy.bitrate_kbps} kbps")
        print(f"  Fades:          {'1s in/out' if strategy.use_fades else 'none'}")

        total_duration = sum(f.duration_seconds for f in files)
        print(f"  Total duration: {format_duration(total_duration)}")

        if output_path:
            print(f"\nOutput: {output_path}")


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'join' subparser."""
    from pathlib import Path

    parser = subparsers.add_parser(
        "join",
        help="Join multiple audio files into a single output",
        description="""\
Concatenates multiple audio files with intelligent format handling:
- Stream copies when files are compatible and --no-fade is used
- Re-encodes with smart quality preservation when formats differ
- Applies 1-second fade transitions by default

Joined files are tracked in audio_catalog_<ts>_joined.csv.

Example:
  catalog join file1.mp3 file2.mp3 -o combined.opus
  catalog join *.wav -o lecture.mp3 --no-fade
  catalog join part1.m4a part2.m4a -o full.opus --analyze
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Audio files to join, in order.",
    )
    # Output options
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        required=True,
        help="Output filename (required). Extension determines format if --format not specified.",
    )
    parser.add_argument(
        "-d",
        "--output-dir",
        type=Path,
        default=None,
        help="Output directory. Defaults to [paths].joined_audio_dir from config.",
    )
    parser.add_argument(
        "-f",
        "--format",
        choices=["opus", "mp3", "m4a", "flac", "wav", "ogg"],
        default=None,
        help="Output format. Inferred from --output extension if omitted. Defaults to Opus for mixed formats.",
    )
    # Audio properties
    parser.add_argument(
        "-r",
        "--sample-rate",
        type=int,
        default=None,
        help="Output sample rate in Hz. Defaults to minimum from source files.",
    )
    parser.add_argument(
        "-c",
        "--channels",
        type=int,
        choices=[1, 2],
        default=None,
        help="Output channel count. Defaults to minimum from source files.",
    )
    parser.add_argument(
        "-m",
        "--mono",
        action="store_true",
        help="Shorthand for --channels 1.",
    )
    parser.add_argument(
        "-s",
        "--stereo",
        action="store_true",
        help="Shorthand for --channels 2.",
    )
    parser.add_argument(
        "-b",
        "--bitrate",
        type=int,
        default=None,
        help="Output bitrate in kbps. Defaults to minimum from lossy sources or 64kbps.",
    )
    # Transitions
    parser.add_argument(
        "--no-fade",
        action="store_true",
        help="Disable 1-second fade transitions (hard cuts). Enables stream copy when files are compatible.",
    )
    # Metadata
    parser.add_argument(
        "--title",
        type=str,
        default=None,
        help="Override title metadata tag.",
    )
    parser.add_argument(
        "--artist",
        type=str,
        default=None,
        help="Override artist metadata tag.",
    )
    parser.add_argument(
        "--album",
        type=str,
        default=None,
        help="Override album metadata tag.",
    )
    # Behavior
    parser.add_argument(
        "-a",
        "--analyze",
        action="store_true",
        help="Show file comparison and strategy without joining.",
    )
    parser.add_argument(
        "-n",
        "--dry-run",
        action="store_true",
        help="Show planned actions without executing.",
    )
    parser.add_argument(
        "--force-reencode",
        action="store_true",
        help="Always re-encode, never stream copy.",
    )
    parser.add_argument(
        "--joined-catalog",
        type=Path,
        default=None,
        help="Joined catalog CSV to check for duplicate joins (defaults to symlink).",
    )
    parser.add_argument(
        "--force-join",
        action="store_true",
        help="Allow re-joining sources that already exist in the joined catalog.",
    )
    parser.add_argument(
        "-y",
        "--yes",
        action="store_true",
        help="Overwrite output without confirmation.",
    )
    parser.add_argument(
        "--no-move-originals",
        action="store_true",
        help=(
            "Do not move source files to the originals backup directory after joining "
            "(default when [paths].original_audio_dir is empty)."
        ),
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Show detailed progress including FFmpeg command.",
    )
    parser.add_argument(
        "--ffmpeg-binary",
        default="ffmpeg",
        help="Path to ffmpeg executable.",
    )
    parser.add_argument(
        "--ffprobe-binary",
        default="ffprobe",
        help="Path to ffprobe executable.",
    )
    parser.set_defaults(func=handle_join)
    return parser


def handle_join(args: argparse.Namespace) -> int:
    """Join multiple audio files into a single output.

    Args:
        args: Parsed command-line arguments.

    Returns:
        Exit code (0 for success, non-zero for failure).
    """
    # Validate input paths
    input_paths: list[Path] = []
    for path_arg in args.paths:
        path = Path(path_arg).expanduser()
        if path.is_file():
            input_paths.append(path)
        else:
            print(f"Error: File not found: {path}", file=sys.stderr)
            return 1

    if len(input_paths) < 2:
        print("Error: At least 2 files required for joining.", file=sys.stderr)
        return 1

    # Probe all input files
    files: list[AudioFileInfo] = []
    print(f"Probing {len(input_paths)} input files...")
    for path in input_paths:
        try:
            info = probe_audio_file(path, ffprobe_binary=args.ffprobe_binary)
            files.append(info)
        except Exception as e:
            print(f"Error probing {path}: {e}", file=sys.stderr)
            return 1

    # Determine channels from flags
    channels_override = None
    if args.mono:
        channels_override = 1
    elif args.stereo:
        channels_override = 2
    elif args.channels:
        channels_override = args.channels

    # Determine output format from extension if not specified
    output_format = args.format
    if not output_format and args.output:
        ext = Path(args.output).suffix.lower()
        format_map = {v: k for k, v in FORMAT_EXTENSIONS.items()}
        output_format = format_map.get(ext)

    # Determine joining strategy
    strategy = determine_join_strategy(
        files,
        use_fades=not args.no_fade,
        force_reencode=args.force_reencode,
        output_format=output_format,
        sample_rate_override=args.sample_rate,
        channels_override=channels_override,
        bitrate_override=args.bitrate,
    )

    # Force re-encode when explicit format differs from source codec
    if strategy.method == "stream_copy" and output_format:
        source_format = CODEC_TO_FORMAT.get(files[0].codec)
        if _normalize_format(source_format) != _normalize_format(output_format):
            strategy = determine_join_strategy(
                files,
                use_fades=False,
                force_reencode=True,
                output_format=output_format,
                sample_rate_override=args.sample_rate,
                channels_override=channels_override,
                bitrate_override=args.bitrate,
            )

    # Compute output path
    output_dir = Path(args.output_dir) if args.output_dir else resolve_joined_audio_root()
    output_filename = args.output
    if not Path(output_filename).suffix:
        # Add extension if missing
        ext = FORMAT_EXTENSIONS.get(strategy.output_format, ".opus")
        output_filename = output_filename + ext
    output_path = output_dir / output_filename

    # Error if explicit format doesn't match output extension
    if output_format:
        expected_ext = FORMAT_EXTENSIONS.get(output_format)
        actual_ext = Path(output_filename).suffix.lower()
        if expected_ext and actual_ext and expected_ext != actual_ext:
            print(
                f"Error: Output extension {actual_ext} doesn't match format {output_format} ({expected_ext})",
                file=sys.stderr,
            )
            return 1

    # Handle --analyze mode
    if args.analyze:
        _print_analysis_table(files, strategy, output_path)
        return 0

    # Handle --dry-run mode
    if args.dry_run:
        _print_analysis_table(files, strategy, output_path)
        print("\nDry run - no files created.")
        return 0

    # Check output exists
    if output_path.exists() and not args.yes:
        response = input(f"Output {output_path} exists. Overwrite? [y/N] ")
        if response.lower() != "y":
            print("Aborted.")
            return 1

    # Create output directory
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Compute source hashes first (needed for metadata comment)
    print("Computing source audio hashes...")
    source_hashes = []
    for f in files:
        h = audio_content_sha256sum(f.path, ffmpeg_binary=args.ffmpeg_binary) or ""
        if not h:
            print(
                f"Error: Could not compute audio hash for {f.path.name}; "
                "cannot safely deduplicate joins.",
                file=sys.stderr,
            )
            return 1
        source_hashes.append(h)

    is_duplicate, message = _check_duplicate_join_in_catalog(source_hashes, args.joined_catalog)
    if is_duplicate and not args.force_join:
        print(f"Error: {message}", file=sys.stderr)
        return 1
    if is_duplicate and args.force_join and message:
        print(f"Warning: {message} (forced)", file=sys.stderr)
    elif message:
        print(f"Warning: {message}", file=sys.stderr)

    # Resolve metadata (includes source hashes and join decision in comment)
    metadata = resolve_join_metadata(
        files,
        source_hashes=source_hashes,
        strategy=strategy,
        title_override=args.title,
        artist_override=args.artist,
        album_override=args.album,
    )

    # Execute join
    print(f"Joining {len(files)} files using {strategy.method}...")
    concat_list_path: Path | None = None

    try:
        if strategy.method == "stream_copy":
            cmd, concat_list_path = build_stream_copy_command(
                files,
                output_path,
                metadata=metadata,
                ffmpeg_binary=args.ffmpeg_binary,
                overwrite=True,
            )
        else:
            cmd = build_reencode_command(
                files,
                output_path,
                strategy,
                metadata=metadata,
                ffmpeg_binary=args.ffmpeg_binary,
                overwrite=True,
            )

        if args.verbose:
            print(f"Command: {' '.join(cmd)}")

        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            print(f"FFmpeg failed (exit {result.returncode}):", file=sys.stderr)
            print(stderr[:1000], file=sys.stderr)
            return 1

    except Exception as e:
        print(f"Error during join: {e}", file=sys.stderr)
        return 1
    finally:
        # Clean up concat list file
        if concat_list_path and concat_list_path.exists():
            concat_list_path.unlink()

    # Verify output exists
    if not output_path.exists():
        print("Error: Output file was not created.", file=sys.stderr)
        return 1

    # Compute output hash (source hashes already computed earlier)
    print("Computing output audio hash...")
    output_hash = audio_content_sha256sum(output_path, ffmpeg_binary=args.ffmpeg_binary) or ""
    if not output_hash:
        print("Warning: Could not compute output hash", file=sys.stderr)

    # Get output duration
    total_duration = sum(f.duration_seconds for f in files)

    if not args.no_move_originals:
        backup_root = resolve_original_audio_root()
        if not backup_root:
            print(
                "Warning: originals backup directory is not configured; "
                "skipping move. Set [paths].original_audio_dir to enable.",
                file=sys.stderr,
            )
        else:
            scan_roots: list[str] = []
            catalog_symlink = get_default_catalog_symlink()
            if catalog_symlink.exists() or catalog_symlink.is_symlink():
                scan_roots = _load_scan_roots_from_catalog(catalog_symlink.resolve())
            if not scan_roots:
                print(
                    "Warning: No scan roots found in main catalog; backup will use filenames only.",
                    file=sys.stderr,
                )

            print(f"Moving source files to backup: {backup_root}")
            try:
                moved = _move_originals(
                    cast(list[AudioFileLike], files),
                    backup_root=backup_root,
                    scan_roots=scan_roots,
                )
            except RuntimeError as exc:
                print(f"Error moving originals: {exc}", file=sys.stderr)
                return 1
            print(f"  Moved {moved} source file(s).")

            source_hashes_set = {h.lower() for h in source_hashes}

            duplicates_symlink = get_default_duplicates_symlink()
            duplicates_csv = (
                duplicates_symlink.resolve()
                if duplicates_symlink.exists() or duplicates_symlink.is_symlink()
                else duplicates_symlink
            )
            duplicate_paths: list[Path] = []
            if duplicates_csv.exists():
                duplicate_paths.extend(
                    _load_duplicate_paths(
                        source_hashes=source_hashes_set,
                        duplicates_csv=duplicates_csv,
                    )
                )

            catalog_csv = (
                catalog_symlink.resolve()
                if catalog_symlink.exists() or catalog_symlink.is_symlink()
                else catalog_symlink
            )
            if catalog_csv.exists():
                duplicate_paths.extend(
                    _load_catalog_paths_for_hashes(
                        source_hashes=source_hashes_set,
                        catalog_csv=catalog_csv,
                    )
                )

            if scan_roots:
                print("Scanning .audiohash sidecars for duplicate paths...")
                duplicate_paths.extend(
                    _load_sidecar_paths_for_hashes(
                        source_hashes=source_hashes_set,
                        scan_roots=scan_roots,
                    )
                )

            deduped_paths: list[Path] = []
            seen_paths: set[str] = set()
            for path in duplicate_paths:
                normalized = _normalize_path_nfc(str(path))
                if normalized in seen_paths:
                    continue
                seen_paths.add(normalized)
                deduped_paths.append(path)

            if not deduped_paths:
                if not duplicates_csv.exists() and not catalog_csv.exists():
                    print(
                        "Warning: duplicates and catalog CSVs not found; skipping duplicate moves.",
                        file=sys.stderr,
                    )
                else:
                    print("No duplicate paths to move for joined sources.")
            else:
                joined_root = resolve_joined_audio_root()
                skip_paths = {_normalize_path_nfc(str(f.path)) for f in files}
                print(f"Moving duplicate files to backup: {backup_root / 'duplicates'}")
                moved_dupes, skipped_missing, skipped_existing, skipped_joined, errors = (
                    _move_duplicate_paths(
                        deduped_paths,
                        backup_root=backup_root,
                        scan_roots=scan_roots,
                        joined_root=joined_root,
                        skip_paths=skip_paths,
                    )
                )
                print(
                    f"  Moved {moved_dupes} duplicate file(s). "
                    f"Skipped missing={skipped_missing} existing={skipped_existing} "
                    f"joined={skipped_joined}."
                )
                if errors:
                    print(
                        f"  Warning: {len(errors)} duplicate move error(s).",
                        file=sys.stderr,
                    )

    # Write to joined catalog
    timestamp = _get_catalog_timestamp()
    csv_path = resolve_catalogs_root() / f"audio_catalog_{timestamp}_joined.csv"

    print(f"Writing to catalog: {csv_path}")
    with JoinedManifestWriter(csv_path) as writer:
        for i, (source, source_hash) in enumerate(zip(files, source_hashes), start=1):
            writer.write_entry(
                source_order=i,
                source=source,
                source_hash=source_hash,
                output_path=output_path,
                output_hash=output_hash,
                output_duration_seconds=total_duration,
                strategy=strategy,
                metadata=metadata,
                source_count=len(files),
            )

    # Create/update symlink
    joined_symlink = get_default_joined_symlink()
    validate_symlink_can_be_created(joined_symlink, description="joined catalog")
    create_or_update_symlink(joined_symlink, csv_path, description="joined catalog")

    # Print summary
    print(f"\nCreated: {output_path}")
    print(f"  Duration: {format_duration(total_duration)}")
    print(f"  Size:     {format_size(output_path.stat().st_size)}")
    print(f"  Strategy: {strategy.method}")
    print(f"  Hash:     {output_hash[:16]}...")
    print(f"\nCatalog: {csv_path}")

    return 0
