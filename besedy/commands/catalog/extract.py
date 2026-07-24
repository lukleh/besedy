"""Transcript sidecar export command."""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn
from rich.text import Text

from besedy.core.paths import (
    assert_catalog_transcripts_alignment,
    require_run_id_from_transcripts_root,
    resolve_catalogs_root,
    resolve_transcripts_root,
)
from besedy.lib.analysis.stats import extract_transcript_text
from besedy.lib.analysis.subtitles import render_srt, render_vtt
from besedy.lib.analysis.timeline import Segment, extract_segments
from besedy.lib.data.encoding import load_json_with_fallback


@dataclass
class ExportTranscriptsRequest:
    transcripts_root: Path | None = None
    workflow: str | None = None
    model: str | None = None
    stats: bool = False
    overwrite: bool = False

    @classmethod
    def from_args(
        cls,
        args: argparse.Namespace | "ExportTranscriptsRequest",
    ) -> "ExportTranscriptsRequest":
        if isinstance(args, cls):
            return args
        return cls(
            transcripts_root=getattr(args, "transcripts_root", None),
            workflow=getattr(args, "workflow", None),
            model=getattr(args, "model", None),
            stats=bool(getattr(args, "stats", False)),
            overwrite=bool(getattr(args, "overwrite", False)),
        )


def _render_txt_sidecar(segments: list[Segment], fallback_text: str) -> str:
    """Render plain-text sidecar as one segment per line."""
    if segments:
        return "\n".join(seg.text for seg in segments).strip()
    return fallback_text.strip()


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'export-transcripts' subparser."""
    parser = subparsers.add_parser(
        "export-transcripts",
        help="Generate subtitle files (txt/srt/vtt) from transcript JSONs",
        description="""\
Creates human-readable and player-compatible files alongside transcript.json:
  transcript.txt  Plain text, one line per segment
  transcript.srt  SubRip format for video players
  transcript.vtt  WebVTT format for web players

Example:
  catalog export-transcripts                           # All transcripts
  catalog export-transcripts --workflow faster-whisper # Only one backend
  catalog export-transcripts --stats                   # Show counts by backend
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--transcripts-root",
        type=Path,
        default=None,
        help="Root directory containing transcript.json files. Default: configured transcripts root.",
    )
    parser.add_argument(
        "--workflow",
        type=str,
        default=None,
        help="Only export transcripts from this backend. Useful when you only want one model's output.",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Only export transcripts from specific model variant (e.g., 'large-v3@silero_vad_v6').",
    )
    parser.add_argument(
        "--stats",
        action="store_true",
        help="Show count of transcripts by backend and model instead of exporting.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing sidecars instead of skipping up-to-date files.",
    )
    parser.set_defaults(func=handle_export_transcripts)
    return parser


def handle_export_transcripts(
    args: argparse.Namespace | ExportTranscriptsRequest,
) -> int:
    """Export transcript sidecars (txt, srt, vtt) next to transcript JSON files."""
    request = ExportTranscriptsRequest.from_args(args)

    # Determine transcripts root (default or user-specified)
    if request.transcripts_root:
        transcripts_root = request.transcripts_root.expanduser()
    else:
        transcripts_root = resolve_transcripts_root()

    if not transcripts_root.exists():
        print(f"Error: Transcripts root not found: {transcripts_root}", file=sys.stderr)
        return 1

    # Resolve symlinks
    if transcripts_root.is_symlink():
        transcripts_root = transcripts_root.resolve()

    # If using default roots, enforce chain alignment
    if request.transcripts_root is None:
        catalogs_root = resolve_catalogs_root()
        catalog_symlink = catalogs_root / "audio_catalog.csv"
        normalized_symlink = catalogs_root / "audio_catalog_normalized.csv"
        try:
            if catalog_symlink.exists() and normalized_symlink.exists():
                assert_catalog_transcripts_alignment(
                    catalog_symlink.resolve(),
                    normalized_symlink.resolve(),
                    transcripts_root,
                )
            require_run_id_from_transcripts_root(transcripts_root)
        except RuntimeError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 1

    console = Console()

    # Discover transcripts first to show count
    transcript_map = _discover_transcripts(transcripts_root, request.workflow, request.model)

    if not transcript_map:
        console.print("[red]Error:[/red] No transcript files found to export.", style="red")
        return 1

    # Count by backend for summary
    backend_counts: dict[tuple[str, str], int] = defaultdict(int)
    for backend, model, _hash in transcript_map.keys():
        backend_counts[(backend, model)] += 1

    console.print(
        f"\n[bold]Exporting transcript sidecars for {len(transcript_map)} transcripts[/bold]"
    )
    console.print(f"  Source: {transcripts_root}")
    console.print("  Output: transcript.txt / transcript.srt / transcript.vtt (next to JSON)")
    if request.workflow or request.model:
        filters = []
        if request.workflow:
            filters.append(f"workflow={request.workflow}")
        if request.model:
            filters.append(f"model={request.model}")
        console.print(f"  Filters: {', '.join(filters)}")
    console.print()

    stats = _export_transcripts_with_progress(
        transcript_map,
        console,
        overwrite=request.overwrite,
    )

    # Always print summary
    _print_stats(stats, console)

    if stats["errors"]:
        return 1

    return 0


def _discover_transcripts(
    transcripts_root: Path,
    workflow_filter: str | None,
    model_filter: str | None,
) -> dict[tuple[str, str, str], Path]:
    """
    Locate transcript files under the given transcripts root.

    Prefers transcript.json when both transcript.json and transcript_original.json
    exist for a hash.
    """
    records: dict[tuple[str, str, str], Path] = {}
    # Prefer canonical transcript.json; fall back to transcript_original.json
    for filename in ("transcript.json", "transcript_original.json"):
        for path in transcripts_root.glob(f"*/*/*/{filename}"):
            backend, model, hash_component = path.relative_to(transcripts_root).parts[:3]
            if workflow_filter and backend != workflow_filter:
                continue
            if model_filter and model != model_filter:
                continue
            key = (backend, model, hash_component)
            # Only overwrite fallback entries with canonical transcript.json
            if key in records and records[key].name == "transcript.json":
                continue
            records[key] = path
    return records


def _export_transcripts_with_progress(
    transcript_map: dict[tuple[str, str, str], Path],
    console: Console,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Export transcript sidecars to .txt/.srt/.vtt files with progress bar."""
    stats: dict[str, Any] = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "by_backend": defaultdict(int),
    }

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("Exporting...", total=len(transcript_map))

        for (backend, model, hash_component), path in sorted(transcript_map.items()):
            progress.update(task, description=f"Exporting {backend}/{hash_component[:8]}...")

            out_dir = path.parent
            out_paths = {
                "txt": out_dir / "transcript.txt",
                "srt": out_dir / "transcript.srt",
                "vtt": out_dir / "transcript.vtt",
            }

            # Skip if output already exists and is newer than source, unless --overwrite.
            source_mtime = path.stat().st_mtime
            if (not overwrite) and all(
                out_path.exists() and out_path.stat().st_mtime >= source_mtime
                for out_path in out_paths.values()
            ):
                stats["skipped"] += 1
                stats["by_backend"][(backend, model)] += 1
                progress.advance(task)
                continue

            try:
                data = load_json_with_fallback(path)
                segments = extract_segments(data, source=f"{backend}/{model}")
                text = extract_transcript_text(data)
                txt_text = _render_txt_sidecar(segments, fallback_text=text)
                srt_text = render_srt(segments)
                vtt_text = render_vtt(segments)
            except Exception as exc:  # pragma: no cover - defensive
                console.print(f"[red]Error reading {path}:[/red] {exc}")
                stats["errors"] += 1
                progress.advance(task)
                continue

            out_dir.mkdir(parents=True, exist_ok=True)

            try:
                out_paths["txt"].write_text(
                    (txt_text or "") + ("\n" if txt_text else ""),
                    encoding="utf-8",
                )
                out_paths["srt"].write_text(srt_text, encoding="utf-8")
                out_paths["vtt"].write_text(vtt_text, encoding="utf-8")
                stats["processed"] += 1
                stats["by_backend"][(backend, model)] += 1
            except Exception as exc:  # pragma: no cover - defensive
                console.print(f"[red]Error writing sidecars for {path}:[/red] {exc}")
                stats["errors"] += 1

            progress.advance(task)

    return stats


def _print_stats(stats: dict[str, Any], console: Console) -> None:
    """Print export summary."""
    processed = stats.get("processed", 0)
    skipped = stats.get("skipped", 0)
    errors = stats.get("errors", 0)
    total = processed + skipped

    console.print()
    if processed > 0 and skipped > 0:
        console.print(
            f"[green]Done![/green] Exported {processed} new, skipped {skipped} existing ({total} total)"
        )
    elif processed > 0:
        console.print(f"[green]Done![/green] Exported {processed} transcript(s) to txt/srt/vtt")
    elif skipped > 0:
        console.print(f"[green]Done![/green] All {skipped} transcripts already up to date")
    else:
        console.print("[yellow]No transcripts processed[/yellow]")

    if errors:
        console.print(f"[red]Encountered {errors} error(s)[/red]")

    by_backend = stats.get("by_backend") or {}
    if by_backend:
        console.print("\nBreakdown by workflow/model:")
        for (backend, model), count in sorted(by_backend.items()):
            # Print path without auto-highlighting (to avoid coloring version numbers)
            # but keep count highlighted
            line = Text(f"  {backend}/{model}: ")
            line.append(str(count), style="repr.number")
            console.print(line)
