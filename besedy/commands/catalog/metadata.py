"""Metadata and ffprobe helpers for catalog processing."""

from __future__ import annotations

import csv
import json
import logging
import subprocess
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import TextIO

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

from besedy.commands.catalog.system import detect_logical_cpus
from besedy.lib.audio.quality import AudioQualityMetrics, analyze_audio_file
from besedy.lib.catalog.manager import (
    DURATION_MISMATCH_TOLERANCE_SECONDS,
    LOSSLESS_DURATION_EXTENSIONS,
    METADATA_TAG_COLUMNS,
    FileRecord,
    audio_content_sha256sum,
    file_record_to_row,
)

METADATA_LOGGER = logging.getLogger("audio_catalog.metadata")
MetadataValue = str | float | None


def format_duration(seconds: float) -> str:
    """Format duration in HH:MM:SS format."""

    total_seconds = int(round(seconds))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def probe_decoded_duration(
    file_path: Path,
    *,
    ffprobe: str,
    timeout: int | None = None,
) -> float | None:
    """Return duration based on decoded audio frames (best-effort timestamps)."""

    # NOTE: Do NOT add "-nostdin" flag here. The custom ffprobe build has a bug
    # where it misparses -nostdin and fails with "Option not found". This has
    # been encountered and fixed multiple times. ffmpeg works fine with -nostdin,
    # but ffprobe does not.
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        str(file_path),
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        return None
    except Exception as exc:
        METADATA_LOGGER.debug("Failed to launch ffprobe duration scan for %s: %s", file_path, exc)
        return None

    last_value: float | None = None
    assert proc.stdout is not None
    try:
        for line in proc.stdout:
            # Strip whitespace AND trailing commas (ffprobe csv output quirk)
            stripped = line.strip().rstrip(",")
            if not stripped or stripped in {"N/A", "nan"}:
                continue
            try:
                last_value = float(stripped)
            except ValueError:
                continue
    finally:
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()

    if proc.returncode not in (0, None):
        return None
    return last_value


def get_basic_metadata(
    file_path: Path,
    ffprobe: str,
    timeout: int,
) -> tuple[dict[str, MetadataValue], str | None]:
    """Get audio metadata using ffprobe.

    Extracts duration, codec, and ID3/format tags. For lossless formats
    (WAV, FLAC, AIFF), uses container metadata only (fast). For lossy
    formats (MP3, OGG, etc.), probes frame timestamps for accurate duration.

    Use get_loudness_metrics() for loudness analysis (full decode).

    Returns:
        Tuple of (metadata_dict, error_message).
    """
    metadata: dict[str, MetadataValue] = {
        "duration": None,
        "duration_seconds": None,
        "date": None,
        "codec": None,
        "extension": file_path.suffix.lower().lstrip("."),
    }
    for tag in METADATA_TAG_COLUMNS:
        metadata.setdefault(tag, None)

    if not file_path.exists():
        return metadata, "file not found"

    # NOTE: Do NOT add "-nostdin" flag here. The custom ffprobe build has a bug
    # where it misparses -nostdin and fails with "Option not found".
    cmd = [
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return metadata, "timeout"
    except Exception as exc:
        return metadata, str(exc)

    if result.returncode != 0:
        return metadata, f"ffprobe exited with {result.returncode}"

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        return metadata, f"invalid ffprobe output ({exc})"

    if "format" in data:
        format_data = data["format"]
        duration_value = format_data.get("duration")
        if duration_value:
            try:
                duration_seconds = float(duration_value)
                metadata["duration_seconds"] = duration_seconds
                metadata["duration"] = format_duration(duration_seconds)
            except ValueError:
                pass

        if "tags" in format_data:
            raw_tags = format_data["tags"] or {}
            tags = {str(key).lower(): value for key, value in raw_tags.items()}
            for tag in METADATA_TAG_COLUMNS:
                if tag == "date":
                    for alias in ("date", "creation_time", "year"):
                        value = tags.get(alias)
                        if value:
                            metadata["date"] = value
                            break
                else:
                    value = tags.get(tag)
                    if value:
                        metadata[tag] = value

    # For lossy formats, use decoded duration for accuracy
    reported_duration = metadata.get("duration_seconds")
    reported_duration_seconds = (
        float(reported_duration) if isinstance(reported_duration, (int, float)) else None
    )
    extension = metadata.get("extension") or ""
    needs_precise_duration = (
        reported_duration_seconds is None or extension not in LOSSLESS_DURATION_EXTENSIONS
    )

    if needs_precise_duration:
        decoded_duration = probe_decoded_duration(
            file_path,
            ffprobe=ffprobe,
            timeout=None,
        )
        if decoded_duration is not None:
            duration_to_compare = (
                reported_duration_seconds if reported_duration_seconds is not None else 0.0
            )
            if (
                reported_duration_seconds is None
                or abs(decoded_duration - duration_to_compare) > DURATION_MISMATCH_TOLERANCE_SECONDS
            ):
                if reported_duration_seconds is not None:
                    METADATA_LOGGER.info(
                        "Adjusted duration for %s from %.2fs to %.2fs based on decoded frames",
                        file_path,
                        reported_duration_seconds,
                        decoded_duration,
                    )
                metadata["duration_seconds"] = decoded_duration
                metadata["duration"] = format_duration(decoded_duration)

    if "streams" in data:
        for stream in data["streams"]:
            if stream.get("codec_type") == "audio":
                metadata["codec"] = stream.get("codec_name")
                break

    return metadata, None


def _duration_seconds_from_metadata(metadata: dict[str, MetadataValue]) -> float:
    value = metadata.get("duration_seconds")
    return float(value) if isinstance(value, (int, float)) else 0.0


def _string_from_metadata(metadata: dict[str, MetadataValue], key: str, default: str = "") -> str:
    value = metadata.get(key)
    return value if isinstance(value, str) else default


def get_loudness_metrics(
    file_path: Path,
    ffmpeg: str,
    ffprobe: str,
) -> tuple[AudioQualityMetrics | None, str | None]:
    """Get loudness and volume metrics (SLOW - requires audio decoding).

    This runs ffmpeg loudnorm and volumedetect filters to analyze
    the audio content. Use for normalization decisions.

    Returns:
        Tuple of (AudioQualityMetrics, error_message).
    """
    if not file_path.exists():
        return None, "file not found"

    try:
        metrics = analyze_audio_file(
            file_path,
            timeout=None,
            ffmpeg_binary=ffmpeg,
            ffprobe_binary=ffprobe,
        )
        return metrics, None
    except Exception as exc:
        return None, str(exc)


def get_audio_metadata(
    file_path: Path,
    ffprobe: str,
    timeout: int,
    ffmpeg: str,
) -> tuple[
    dict[str, MetadataValue],
    str | None,
    AudioQualityMetrics | None,
    str | None,
]:
    """Get audio metadata using ffprobe (DEPRECATED - use get_basic_metadata instead).

    This function combines basic metadata AND loudness analysis.
    For the new pipeline, use:
    - get_basic_metadata() for fast catalog creation
    - get_loudness_metrics() for loudness analysis
    """
    # Get basic metadata
    metadata, metadata_error = get_basic_metadata(file_path, ffprobe, timeout)
    if metadata_error:
        return metadata, metadata_error, None, metadata_error

    # Get loudness metrics (slow)
    quality_metrics, quality_error = get_loudness_metrics(file_path, ffmpeg, ffprobe)

    # Compute audio content hash (redundant - already computed during catalog create)
    # Kept for backward compatibility
    content_hash = audio_content_sha256sum(
        file_path,
        ffmpeg_binary=ffmpeg,
        timeout=None,
    )
    metadata["audio_content_hash"] = content_hash

    return metadata, None, quality_metrics, quality_error


def enrich_records(
    records: list[FileRecord],
    *,
    ffprobe: str,
    ffmpeg: str,
    timeout: int,
    use_color: bool,
    csv_writer: csv.DictWriter | None = None,
    csv_columns: Sequence[str] | None = None,
    flush_handle: TextIO | None = None,
) -> float:
    """Enrich file records with metadata from ffprobe."""

    total_seconds = 0.0
    total = len(records)
    if total == 0:
        return 0.0

    workers = min(max(1, detect_logical_cpus() - 1), total)
    console = Console(force_terminal=use_color)
    console.print(f"[cyan]Launching ffprobe with {workers} worker(s) for {total} file(s)...[/cyan]")

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
        task = progress.add_task("Computing audio hashes & metadata", total=total)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    get_audio_metadata,
                    record.full_path,
                    ffprobe,
                    timeout,
                    ffmpeg,
                ): record
                for record in records
            }

            for future in as_completed(futures):
                record = futures[future]
                try:
                    metadata, metadata_error, metrics, quality_error = future.result()
                except Exception as exc:
                    metadata = {}
                    metadata_error = str(exc)
                    metrics = None
                    quality_error = str(exc)

                record.duration = _string_from_metadata(metadata, "duration")
                record.duration_seconds = _duration_seconds_from_metadata(metadata)
                for tag in METADATA_TAG_COLUMNS:
                    setattr(record, tag, _string_from_metadata(metadata, tag))
                record.codec = _string_from_metadata(metadata, "codec")
                record.extension = _string_from_metadata(metadata, "extension", record.extension)
                record.audio_content_hash = _string_from_metadata(metadata, "audio_content_hash")

                if metrics:
                    record.sample_rate = metrics.sample_rate
                    record.bit_depth = metrics.bit_depth
                    record.channels = metrics.channels
                    record.bitrate_kbps = metrics.bitrate_kbps
                    record.integrated_loudness_lufs = metrics.integrated_loudness_lufs
                    record.true_peak_db = metrics.true_peak_db
                    record.loudness_range_lu = metrics.loudness_range_lu
                    record.input_thresh = metrics.input_thresh
                    record.target_offset = metrics.target_offset
                    record.mean_volume_db = metrics.mean_volume_db
                    record.max_volume_db = metrics.max_volume_db
                    record.needs_normalization = metrics.needs_normalization
                    record.codec_profile = metrics.codec_profile

                if record.duration_seconds:
                    total_seconds += record.duration_seconds

                issues: list[str] = []
                if metadata_error:
                    issues.append(f"metadata: {metadata_error}")
                if quality_error:
                    issues.append(f"quality: {quality_error}")

                if issues:
                    progress.console.print(
                        f"  [red]✗[/red] {rich_escape(record.filename)}: {'; '.join(issues)}",
                        highlight=False,
                    )
                else:
                    progress.console.print(
                        f"  [green]✓[/green] {rich_escape(record.filename)}",
                        highlight=False,
                    )

                progress.advance(task)

                if csv_writer is not None and csv_columns is not None:
                    csv_writer.writerow(file_record_to_row(record, csv_columns))
                    if flush_handle is not None:
                        flush_handle.flush()

    return total_seconds


def enrich_basic_records(
    records: list[FileRecord],
    *,
    ffprobe: str,
    timeout: int,
    use_color: bool,
    csv_writer: csv.DictWriter | None = None,
    csv_columns: Sequence[str] | None = None,
    flush_handle: TextIO | None = None,
) -> float:
    """Enrich file records with basic metadata only (FAST - no loudness analysis).

    This is the fast version for catalog create. It extracts:
    - Duration (with decoded duration fallback for lossy formats)
    - Codec information
    - ID3/format tags (album, artist, date, etc.)

    It does NOT compute:
    - Loudness metrics (integrated_loudness_lufs, true_peak_db, etc.)
    - Volume metrics (mean_volume_db, max_volume_db)
    - needs_normalization flag

    Use enrich_records() or catalog loudness for full analysis.
    """
    total_seconds = 0.0
    total = len(records)
    if total == 0:
        return 0.0

    workers = min(max(1, detect_logical_cpus() - 1), total)
    console = Console(force_terminal=use_color)
    console.print(
        f"[cyan]Extracting metadata with {workers} worker(s) for {total} file(s)...[/cyan]"
    )

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
        task = progress.add_task("Extracting metadata", total=total)

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    get_basic_metadata,
                    record.full_path,
                    ffprobe,
                    timeout,
                ): record
                for record in records
            }

            for future in as_completed(futures):
                record = futures[future]
                try:
                    metadata, metadata_error = future.result()
                except Exception as exc:
                    metadata = {}
                    metadata_error = str(exc)

                record.duration = _string_from_metadata(metadata, "duration")
                record.duration_seconds = _duration_seconds_from_metadata(metadata)
                for tag in METADATA_TAG_COLUMNS:
                    setattr(record, tag, _string_from_metadata(metadata, tag))
                record.codec = _string_from_metadata(metadata, "codec")
                record.extension = _string_from_metadata(metadata, "extension", record.extension)

                if record.duration_seconds:
                    total_seconds += record.duration_seconds

                if metadata_error:
                    progress.console.print(
                        f"  [red]✗[/red] {rich_escape(record.filename)}: {metadata_error}",
                        highlight=False,
                    )
                else:
                    progress.console.print(
                        f"  [green]✓[/green] {rich_escape(record.filename)}",
                        highlight=False,
                    )

                progress.advance(task)

                if csv_writer is not None and csv_columns is not None:
                    csv_writer.writerow(file_record_to_row(record, csv_columns))
                    if flush_handle is not None:
                        flush_handle.flush()

    return total_seconds
