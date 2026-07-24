"""Calculate audio content hashes for files or directories."""

from __future__ import annotations

import argparse
import csv
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from rich.console import Console
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.commands.catalog.system import detect_logical_cpus
from besedy.core.paths import resolve_catalogs_root
from besedy.lib.catalog.manager import (
    audio_content_sha256sum,
    check_ffmpeg,
    collect_input_files,
    get_supported_audio_extensions,
    load_csv,
    read_fresh_audio_hash_sidecar,
    source_file_sha256,
    write_audio_hash_sidecar,
)


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'hash' subparser."""
    parser = subparsers.add_parser(
        "hash",
        help="Calculate audio content hashes for files or directories",
        description="""\
Computes SHA-256 hashes of decoded PCM audio (16kHz mono). Files that cannot be
decoded are rejected instead of silently receiving a different kind of hash.

Output format: <hash>  <path>

Examples:
  catalog hash /path/to/audio.mp3              # Hash single file
  catalog hash /path/to/audio/dir              # Hash all audio files in directory
  catalog hash *.wav --output hashes.csv       # Save to CSV
  catalog hash                                 # Hash files from catalog scan roots
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Files or directories to hash. If omitted, uses 'Scan Root' values from the catalog.",
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Catalog CSV to read scan roots from. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        help="Output CSV path. If not specified, prints '<hash>  <path>' lines.",
    )
    parser.add_argument(
        "--no-sidecar",
        action="store_true",
        help="Don't read or write .audiohash sidecar files.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored terminal output.",
    )
    parser.add_argument(
        "--no-audio-filter",
        action="store_true",
        help="Process ALL files, not just audio extensions.",
    )
    parser.set_defaults(func=handle_hash)
    return parser


def compute_hash_for_file(
    file_path: Path,
    *,
    use_sidecar: bool = True,
) -> tuple[str | None, str | None, str | None]:
    """Compute audio content hash for a single file.

    Args:
        file_path: Path to the audio file.
        use_sidecar: If True, read/write a typed .audiohash sidecar.

    Returns:
        Tuple of (hash, error, warning). On success, error is None.
    """
    import unicodedata

    try:
        file_stat = file_path.stat()
        file_mtime = file_stat.st_mtime
    except OSError as exc:
        return None, f"Failed to stat {file_path}: {exc}", None

    normalized_name = unicodedata.normalize("NFC", file_path.name)
    hash_file = Path(f"{file_path}.audiohash")
    warning: str | None = None

    hash_value = None
    if use_sidecar:
        hash_value = read_fresh_audio_hash_sidecar(
            hash_file,
            source_path=file_path,
            source_mtime=file_mtime,
        )

    if hash_value is None:
        hash_value = audio_content_sha256sum(file_path)
        if hash_value is None:
            return (
                None,
                f"Unable to compute canonical audio hash for {file_path}: audio decoding failed",
                None,
            )

        if use_sidecar:
            try:
                write_audio_hash_sidecar(
                    hash_file,
                    hash_value=hash_value,
                    filename=normalized_name,
                    source_file_sha256=source_file_sha256(file_path),
                )
            except OSError as exc:
                if warning:
                    warning += f"; also unable to write sidecar: {exc}"
                else:
                    warning = f"Unable to write hash sidecar for {file_path}: {exc}"

    return hash_value, None, warning


def handle_hash(args: argparse.Namespace) -> int:
    """Calculate audio content hashes for files or directories."""
    use_color = sys.stdout.isatty() and not args.no_color
    console = Console(force_terminal=use_color)
    use_sidecar = not args.no_sidecar

    # Auto-detect paths if not provided: use unique Scan Root values from catalog
    if not args.paths:
        # Resolve catalog path
        if args.csv:
            catalog_path = args.csv.expanduser()
        else:
            symlink_path = resolve_catalogs_root() / "audio_catalog.csv"
            if symlink_path.exists() or symlink_path.is_symlink():
                catalog_path = symlink_path.resolve()
            else:
                print(
                    f"Error: No paths provided and default catalog '{symlink_path}' not found.",
                    file=sys.stderr,
                )
                return 1

        if not catalog_path.is_file():
            print(f"Error: Catalog not found at {catalog_path}", file=sys.stderr)
            return 1

        # Load catalog to get scan roots
        try:
            _, existing_rows = load_csv(catalog_path, encoding="utf-8")
        except Exception as exc:
            print(f"Error reading {catalog_path}: {exc}", file=sys.stderr)
            return 1

        scan_roots: set[str] = set()
        for row in existing_rows:
            scan_root = (row.get("Scan Root", "") or "").strip()
            if scan_root:
                scan_roots.add(scan_root)

        if not scan_roots:
            print(
                "Error: No 'Scan Root' values found in catalog. Provide paths explicitly.",
                file=sys.stderr,
            )
            return 1

        # Validate directories exist
        valid_roots: list[Path] = []
        for root in sorted(scan_roots):
            root_path = Path(root)
            if root_path.is_dir():
                valid_roots.append(root_path)
            else:
                print(f"Warning: Scan root not found, skipping: {root}")

        if not valid_roots:
            print("Error: None of the scan roots exist.", file=sys.stderr)
            return 1

        print(f"Using {len(valid_roots)} scan root(s) from catalog:")
        for root in valid_roots:
            print(f"  {root}")
        args.paths = valid_roots

    # Detect supported audio extensions
    supported_extensions: set[str] | None = None
    if not args.no_audio_filter:
        if check_ffmpeg("ffmpeg"):
            try:
                supported_extensions = get_supported_audio_extensions("ffmpeg")
            except RuntimeError as e:
                print(f"Warning: {e}. Audio filtering disabled.", file=sys.stderr)
        else:
            print("Warning: ffmpeg not found, audio filtering disabled", file=sys.stderr)

    # Expand paths to files
    input_paths = [
        p.expanduser() if isinstance(p, Path) else Path(p).expanduser() for p in args.paths
    ]
    input_files, warnings = collect_input_files(
        input_paths, supported_extensions=supported_extensions
    )
    for warning in warnings:
        print(warning, file=sys.stderr)

    if not input_files:
        print("No audio files found.", file=sys.stderr)
        return 0

    # Process files in parallel
    results: list[tuple[Path, str]] = []
    errors: list[str] = []
    hash_warnings: list[str] = []

    sorted_files = sorted(input_files)
    workers = min(max(1, detect_logical_cpus() - 1), len(sorted_files))

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        task = progress.add_task(
            f"Hashing {len(sorted_files)} files ({workers} workers)...",
            total=len(sorted_files),
        )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_path = {
                executor.submit(
                    compute_hash_for_file,
                    fp,
                    use_sidecar=use_sidecar,
                ): fp
                for fp in sorted_files
            }

            for future in as_completed(future_to_path):
                file_path = future_to_path[future]
                hash_value, error, warning = future.result()

                if error:
                    errors.append(error)
                elif hash_value:
                    results.append((file_path, hash_value))

                if warning:
                    hash_warnings.append(warning)

                progress.advance(task)

    # Print warnings and errors
    for warning in hash_warnings:
        console.print(f"[yellow]Warning:[/yellow] {warning}")
    for error in errors:
        print(error, file=sys.stderr)

    # Output results
    if args.output:
        # Write CSV
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["Hash", "Path"])
            for file_path, hash_value in sorted(results):
                writer.writerow([hash_value, str(file_path)])
        console.print(f"[green]Wrote {len(results)} hashes to:[/green] {args.output}")
    else:
        # Print one hash and path per line.
        for file_path, hash_value in sorted(results):
            print(f"{hash_value}  {file_path}")

    return 0
