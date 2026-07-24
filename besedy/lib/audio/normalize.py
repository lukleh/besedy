"""Audio normalization and staging pipeline.

This module provides functions for:
- Staging audio files with format conversion to 16kHz mono WAV
- EBU R128 loudness normalization
- Parallel processing using FFmpeg
- Declipping for clipped audio

Ownership note:
- keep the end-to-end staging workflow and manifest-writing flow here
- keep reusable probing, quality analysis, and decode helpers in adjacent
  `besedy.lib.audio.*` modules so command-layer changes do not need to edit
  this whole file
"""

from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.markup import escape as rich_escape
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
    TimeElapsedColumn,
)

from besedy.core.paths import hash_component_from_sha
from besedy.lib.audio.normalize_stage_helpers import (
    ConversionLogNoticeState,
    resolve_analysis_binary,
    reuse_existing_staged_entry,
    run_stage_conversion,
)
from besedy.lib.audio.types import (
    CONVERSION_LOG_DIR,
    STAGED_AUDIO_EXTENSION,
    ManifestWriter,
    PreparedEntry,
    SkippedEntry,
    detect_logical_cpus,
)
from besedy.lib.workflow.common import CsvAudioRow, resolve_unicode_path


def stage_audio_files(
    rows: Sequence[CsvAudioRow],
    staging_dir: Path,
    *,
    manifest_writer: ManifestWriter,
    include_audio_analysis: bool,
    analysis_ffmpeg: str,
    analysis_ffprobe: str,
    continue_on_error: bool,
    reuse_existing: bool = False,
    aggressive_normalization: bool = True,
    verbose: bool = False,
) -> tuple[list[PreparedEntry], list[SkippedEntry]]:
    """Stage audio files by converting to normalized 16kHz mono WAV."""
    prepared: list[PreparedEntry] = []
    skipped: list[SkippedEntry] = []
    seen_hashes: dict[str, Path] = {}

    conversions: list[tuple[int, CsvAudioRow, Path, Path, float]] = []
    console = Console()
    total_rows = len(rows)

    if include_audio_analysis:
        analysis_ffmpeg_bin = resolve_analysis_binary(analysis_ffmpeg)
        analysis_ffprobe_bin = resolve_analysis_binary(analysis_ffprobe)
    else:
        analysis_ffmpeg_bin = analysis_ffmpeg
        analysis_ffprobe_bin = analysis_ffprobe

    for index, row in enumerate(rows, start=1):
        duration_seconds = row.duration_seconds
        if duration_seconds is None:
            raise RuntimeError(f"Duration missing for SHA {row.sha256} at row {index}")
        source, resolved_str, exists = resolve_unicode_path(row.full_path)
        hash_component = hash_component_from_sha(row.sha256)
        staged_path = staging_dir / f"{hash_component}{STAGED_AUDIO_EXTENSION}"

        if hash_component in seen_hashes:
            skipped.append(SkippedEntry(row.sha256, source, "duplicate hash in CSV"))
            if not continue_on_error:
                raise RuntimeError(f"Duplicate hash encountered: {row.sha256}")
            continue

        if (staged_path.exists() or staged_path.is_symlink()) and reuse_existing:
            if not exists:
                logging.warning(
                    "[stage_audio_files] source missing for %s; reusing existing staged file %s",
                    resolved_str,
                    staged_path,
                )
            if verbose:
                status_suffix = "reusing existing"
                if not exists:
                    status_suffix += ", source missing"
                console.print(
                    f"  [dim]↻[/dim] {rich_escape(source.name)} ({status_suffix})",
                    highlight=False,
                )
            entry, existing_size_bytes, existing_metrics = reuse_existing_staged_entry(
                row=row,
                source=source,
                staged_path=staged_path,
                duration_seconds=duration_seconds,
                include_audio_analysis=include_audio_analysis,
                analysis_ffmpeg_bin=analysis_ffmpeg_bin,
                analysis_ffprobe_bin=analysis_ffprobe_bin,
                continue_on_error=continue_on_error,
            )
            manifest_writer.write_entry(
                entry,
                size_bytes=existing_size_bytes,
                metrics=existing_metrics,
            )
            prepared.append(entry)
            continue

        if not exists:
            skipped.append(SkippedEntry(row.sha256, source, "file not found"))
            if not continue_on_error:
                raise RuntimeError(f"Audio file not found: {resolved_str}")
            continue

        if staged_path.exists() or staged_path.is_symlink():
            try:
                staged_path.unlink()
            except FileNotFoundError:
                pass

        conversions.append((index, row, source, staged_path, duration_seconds))
        seen_hashes[hash_component] = source

    log_file_path: Path | None = None
    log_write_lock: threading.Lock | None = None

    if conversions:
        ffmpeg_binary = shutil.which("ffmpeg")
        if ffmpeg_binary is None:
            raise RuntimeError(
                "ffmpeg executable not found in PATH. Install ffmpeg to normalize/convert audio "
                "or ensure it is accessible."
            )

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_dir = CONVERSION_LOG_DIR
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            log_dir = None  # type: ignore[assignment]
        if log_dir is not None:
            log_file_path = log_dir / f"ffmpeg_stage_{timestamp}.log"
            log_write_lock = threading.Lock()
            try:
                with log_file_path.open("a", encoding="utf-8") as handle:
                    handle.write(f"# ffmpeg stage log started at {datetime.now().isoformat()}\n")
            except Exception:
                log_file_path = None
                log_write_lock = None

        cpu_limit = max(1, detect_logical_cpus())
        workers = min(cpu_limit, len(conversions))
        console.print(
            f"[cyan]Launching ffmpeg with {workers} worker(s) "
            f"(cpu limit {cpu_limit}, conversions {len(conversions)})...[/cyan]",
            highlight=False,
        )

        notice_state = ConversionLogNoticeState(log_file_path=log_file_path)

        def append_log_block(lines: Sequence[str]) -> None:
            if not lines or log_file_path is None or log_write_lock is None:
                return
            try:
                with log_write_lock:
                    with log_file_path.open("a", encoding="utf-8") as handle:
                        handle.write(f"[{datetime.now().isoformat()}] {lines[0]}\n")
                        for line in lines[1:]:
                            handle.write(f"{line}\n")
                        handle.write("-" * 80 + "\n")
            except Exception:
                pass

        already_processed = len(prepared) + len(skipped)

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TaskProgressColumn(),
            TextColumn("{task.completed}/{task.total}"),
            TimeElapsedColumn(),
            console=console,
            transient=False,
        ) as progress:
            task = progress.add_task(
                "Staging audio files", total=total_rows, completed=already_processed
            )

            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = [
                    executor.submit(
                        run_stage_conversion,
                        item,
                        ffmpeg_binary=ffmpeg_binary,
                        include_audio_analysis=include_audio_analysis,
                        analysis_ffmpeg_bin=analysis_ffmpeg_bin,
                        analysis_ffprobe_bin=analysis_ffprobe_bin,
                        continue_on_error=continue_on_error,
                        aggressive_normalization=aggressive_normalization,
                        log_notice_state=notice_state,
                    )
                    for item in conversions
                ]
                for future in as_completed(futures):
                    result = future.result()

                    if result.prepared:
                        display_name = result.prepared.source.name
                    elif result.skipped:
                        display_name = result.skipped.source.name
                    else:
                        display_name = "unknown"

                    if result.log_lines:
                        log_block = list(result.log_lines)
                        warning_lines = [
                            message.text for message in (result.messages or ()) if message.is_error
                        ]
                        if warning_lines:
                            log_block.append("Warnings:")
                            log_block.extend(warning_lines)
                        append_log_block(log_block)

                    if result.prepared:
                        manifest_writer.write_entry(
                            result.prepared,
                            size_bytes=result.size_bytes,
                            metrics=result.metrics,
                        )
                        prepared.append(result.prepared)
                        has_warnings = any(m.is_error for m in (result.messages or ()))
                        if has_warnings:
                            progress.console.print(
                                f"  [green]✓[/green] {rich_escape(display_name)} [dim](with warnings)[/dim]",
                                highlight=False,
                            )
                        else:
                            progress.console.print(
                                f"  [green]✓[/green] {rich_escape(display_name)}",
                                highlight=False,
                            )
                    elif result.skipped:
                        skipped.append(result.skipped)
                        progress.console.print(
                            f"  [red]✗[/red] {rich_escape(display_name)}: {rich_escape(result.skipped.reason)}",
                            highlight=False,
                        )
                        if not continue_on_error:
                            raise RuntimeError(
                                f"ffmpeg conversion failed for {result.skipped.source}"
                            )

                    progress.advance(task)

    return prepared, skipped
