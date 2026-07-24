"""Detailed worker helpers for the audio staging pipeline."""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from pathlib import Path

from besedy.config.settings import config
from besedy.lib.audio.decode import decode_to_temp_wav
from besedy.lib.audio.probe import probe_media_duration_seconds
from besedy.lib.audio.quality import (
    AudioQualityMetrics,
    analyze_audio_file,
    determine_needs_normalization,
    needs_declipping,
)
from besedy.lib.audio.types import (
    DECLIP_THRESHOLD_DBTP,
    DURATION_TOLERANCE_MIN_SECONDS,
    DURATION_TOLERANCE_PERCENTAGE,
    FILESIZE_MISMATCH_DRIFT_TOLERANCE,
    LOUDNESS_RANGE_LU,
    LOUDNESS_TARGET_LUFS,
    NON_MONOTONIC_MAX_RATIO,
    NON_MONOTONIC_MIN_RATIO,
    TARGET_CHANNELS,
    TRUE_PEAK_TARGET_DBTP,
    ConversionLogMessage,
    ConversionResult,
    PreparedEntry,
    SkippedEntry,
)
from besedy.lib.subprocess_utils import safe_decode
from besedy.lib.workflow.common import CsvAudioRow


@dataclass
class ConversionLogNoticeState:
    """Track whether we've already told the caller where the ffmpeg log lives."""

    log_file_path: Path | None
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _notified: bool = False

    def take_notice(self) -> str | None:
        if self.log_file_path is None:
            return None
        with self._lock:
            if self._notified:
                return None
            self._notified = True
        return f"[stage_audio_files] ffmpeg logs are being written to {self.log_file_path}"


def resolve_analysis_binary(binary: str) -> str:
    path = shutil.which(binary)
    if path:
        return path
    candidate = Path(binary)
    if candidate.exists():
        return str(candidate)
    raise RuntimeError(
        f"Executable '{binary}' is required for audio analysis but was not found in PATH."
    )


def reuse_existing_staged_entry(
    *,
    row: CsvAudioRow,
    source: Path,
    staged_path: Path,
    duration_seconds: float,
    include_audio_analysis: bool,
    analysis_ffmpeg_bin: str,
    analysis_ffprobe_bin: str,
    continue_on_error: bool,
) -> tuple[PreparedEntry, int, AudioQualityMetrics | None]:
    entry = PreparedEntry(row.sha256, source, staged_path, "existing", duration_seconds)

    existing_size_bytes = 0
    existing_metrics: AudioQualityMetrics | None = None
    try:
        existing_size_bytes = staged_path.stat().st_size
    except OSError as size_exc:
        logging.warning(
            "[stage_audio_files] unable to stat existing file %s: %s",
            staged_path,
            size_exc,
        )

    has_metrics_from_csv = bool(
        row.integrated_loudness_lufs and row.true_peak_db and row.loudness_range_lu
    )

    if include_audio_analysis and not has_metrics_from_csv:
        try:
            existing_metrics = analyze_audio_file(
                staged_path,
                timeout=None,
                ffmpeg_binary=analysis_ffmpeg_bin,
                ffprobe_binary=analysis_ffprobe_bin,
            )
        except Exception as exc:
            logging.warning(
                "[stage_audio_files] audio analysis failed for existing file %s: %s",
                staged_path,
                exc,
            )
            if not continue_on_error:
                raise RuntimeError(f"audio analysis failed for {staged_path}: {exc}") from exc
    elif has_metrics_from_csv:
        try:
            existing_metrics = AudioQualityMetrics(
                integrated_loudness_lufs=row.integrated_loudness_lufs or "",
                true_peak_db=row.true_peak_db or "",
                loudness_range_lu=row.loudness_range_lu or "",
                input_thresh=row.input_thresh or "",
                target_offset=row.target_offset or "",
            )
        except (ValueError, TypeError) as metric_exc:
            logging.warning(
                "[stage_audio_files] failed to parse metrics from CSV for %s: %s",
                staged_path,
                metric_exc,
            )

    return entry, existing_size_bytes, existing_metrics


def run_stage_conversion(
    item: tuple[int, CsvAudioRow, Path, Path, float],
    *,
    ffmpeg_binary: str,
    include_audio_analysis: bool,
    analysis_ffmpeg_bin: str,
    analysis_ffprobe_bin: str,
    continue_on_error: bool,
    aggressive_normalization: bool,
    log_notice_state: ConversionLogNoticeState,
) -> ConversionResult:
    """Convert one input row into a staged WAV plus optional analysis metrics."""

    _index, row, source, staged_path, duration_seconds = item
    effective_duration = duration_seconds
    messages: list[ConversionLogMessage] = []

    temp_fd, temp_path_str = tempfile.mkstemp(suffix=".wav", prefix="stage_")
    temp_wav = Path(temp_path_str)
    os.close(temp_fd)

    ok, decode_error = decode_to_temp_wav(
        source,
        temp_wav,
        ffmpeg_binary=ffmpeg_binary,
    )
    if not ok:
        messages.append(
            ConversionLogMessage(
                f"[stage_audio_files] decode failed for {source}: {decode_error}",
                is_error=True,
            )
        )
        return ConversionResult(
            None,
            SkippedEntry(row.sha256, source, f"decode failed: {decode_error}"),
            tuple(messages),
            (),
        )

    try:
        input_for_normalization = temp_wav

        has_norm_data = all(
            [
                row.integrated_loudness_lufs,
                row.true_peak_db,
                row.loudness_range_lu,
                row.input_thresh,
                row.target_offset,
            ]
        )
        normalized = has_norm_data

        aresample_component = "aresample=async=1:first_pts=0"
        filter_components: list[str] = []

        apply_declipping = needs_declipping(row.true_peak_db, threshold=DECLIP_THRESHOLD_DBTP)
        if apply_declipping:
            filter_components.append("adeclip=window=55:overlap=75:arorder=8:threshold=10:method=a")

        if has_norm_data:
            filter_components.append(
                f"loudnorm=I={LOUDNESS_TARGET_LUFS}:LRA={LOUDNESS_RANGE_LU}:"
                f"tp={TRUE_PEAK_TARGET_DBTP}:"
                f"measured_I={row.integrated_loudness_lufs}:"
                f"measured_LRA={row.loudness_range_lu}:"
                f"measured_tp={row.true_peak_db}:"
                f"measured_thresh={row.input_thresh}:"
                f"offset={row.target_offset}:"
                f"linear=true"
            )

        filter_components.append(aresample_component)

        audio_filter_with_async = ",".join(filter_components)
        simplified_components = filter_components[:-1]
        simplified_filter = ",".join(simplified_components).strip(",")

        label_parts = []
        if apply_declipping:
            label_parts.append("declip")
        if has_norm_data:
            label_parts.append("normalize")
        label_parts.append("convert")
        base_conversion_label = "+".join(label_parts) if label_parts else "convert (no processing)"
        filter_variants: list[tuple[str | None, bool, str]] = [
            (audio_filter_with_async, True, base_conversion_label),
        ]
        if simplified_filter != audio_filter_with_async:
            fallback_label = f"{base_conversion_label} (no async)"
            filter_variants.append((simplified_filter or None, False, fallback_label))

        retry_without_async_triggered = False

        for variant_index, (filter_value, uses_async_filter, conversion_label) in enumerate(
            filter_variants
        ):
            if variant_index > 0:
                try:
                    staged_path.unlink()
                except FileNotFoundError:
                    pass

            ffmpeg_cmd = [
                ffmpeg_binary,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(input_for_normalization),
                "-vn",
            ]
            if filter_value:
                ffmpeg_cmd.extend(["-af", filter_value])
            ffmpeg_cmd.extend(
                [
                    "-ac",
                    str(TARGET_CHANNELS),
                    "-ar",
                    str(config.audio.sample_rate),
                    "-c:a",
                    "pcm_s16le",
                    "-f",
                    "wav",
                    str(staged_path),
                ]
            )

            messages.append(
                ConversionLogMessage(
                    f"[stage_audio_files] {conversion_label} command: {shlex.join(ffmpeg_cmd)}"
                )
            )

            try:
                result = subprocess.run(ffmpeg_cmd, capture_output=True)
                stdout_output = safe_decode(result.stdout)
                stderr_output = safe_decode(result.stderr)
            except FileNotFoundError as exc:
                stdout_output = ""
                stderr_output = str(exc)
                result = None

            if result is None or result.returncode != 0:
                if staged_path.exists():
                    staged_path.unlink()
                log_excerpt = (
                    stderr_output.strip().splitlines()[-1] if stderr_output else "ffmpeg failed"
                )
                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] ffmpeg conversion failed for {source}: {log_excerpt}",
                        is_error=True,
                    )
                )
                failure_sections = [
                    f"FAILURE {row.sha256}",
                    f"Source: {source}",
                    f"Command: {shlex.join(ffmpeg_cmd)}",
                    f"Reason: {log_excerpt}",
                ]
                if stdout_output:
                    failure_sections.append("STDOUT:\n" + stdout_output)
                if stderr_output:
                    failure_sections.append("STDERR:\n" + stderr_output)
                if notice := log_notice_state.take_notice():
                    messages.append(ConversionLogMessage(notice, is_error=True))
                return ConversionResult(
                    None,
                    SkippedEntry(row.sha256, source, f"ffmpeg failed: {log_excerpt}"),
                    tuple(messages),
                    tuple(failure_sections),
                )

            if stdout_output:
                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] ffmpeg stdout for {source}:\n{stdout_output.strip()}"
                    )
                )
            if stderr_output:
                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] ffmpeg stderr for {source}:\n{stderr_output.strip()}",
                        is_error=True,
                    )
                )
            stderr_text = stderr_output
            aresample_compensation_failed = (
                "Failed to compensate for timestamp delta" in stderr_text
            )

            try:
                output_size = staged_path.stat().st_size
            except OSError as stat_exc:
                output_size = 0
                stat_error = stat_exc
            else:
                stat_error = None

            if stat_error is not None or output_size <= 0:
                if staged_path.exists():
                    staged_path.unlink()
                detail = (
                    f"stat failed ({stat_error})" if stat_error else "output size was zero bytes"
                )
                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] ffmpeg reported success but {detail} for {source}",
                        is_error=True,
                    )
                )
                failure_lines = [
                    f"FAILURE {row.sha256}",
                    f"Source: {source}",
                    f"Expected output: {staged_path}",
                    f"Command: {shlex.join(ffmpeg_cmd)}",
                    f"Reason: {detail}",
                    "ExitCode: 0",
                ]
                if notice := log_notice_state.take_notice():
                    messages.append(ConversionLogMessage(notice, is_error=True))
                return ConversionResult(
                    None,
                    SkippedEntry(
                        row.sha256, source, f"conversion produced invalid output ({detail})"
                    ),
                    tuple(messages),
                    tuple(failure_lines),
                )

            duration_error: str | None = None
            converted_duration: float | None = None
            expected_duration = duration_seconds
            ffprobe_path = shutil.which("ffprobe")
            if expected_duration > 0 and ffprobe_path:
                converted_duration, converted_duration_error = probe_media_duration_seconds(
                    staged_path,
                    ffprobe=ffprobe_path,
                )
                if converted_duration_error:
                    duration_error = converted_duration_error
            elif expected_duration > 0 and not ffprobe_path:
                messages.append(
                    ConversionLogMessage(
                        "[stage_audio_files] ffprobe not found; skipping duration verification",
                    )
                )

            if converted_duration is not None:
                tolerance = max(
                    DURATION_TOLERANCE_MIN_SECONDS,
                    expected_duration * DURATION_TOLERANCE_PERCENTAGE,
                )
                if converted_duration <= 0:
                    duration_error = "reported duration was non-positive"
                elif abs(converted_duration - expected_duration) > tolerance:
                    duration_error = (
                        f"duration mismatch (expected {expected_duration:.2f}s, "
                        f"got {converted_duration:.2f}s, tolerance ±{tolerance:.2f}s)"
                    )

            duration_mismatch_tolerated = False
            duration_mismatch_ratio = 0.0
            duration_ratio = 0.0
            warning_texts = [message.text.lower() for message in messages]
            if (
                duration_error is not None
                and converted_duration is not None
                and expected_duration > 0
            ):
                diff_seconds = abs(converted_duration - expected_duration)
                duration_mismatch_ratio = diff_seconds / expected_duration
                duration_ratio = (
                    converted_duration / expected_duration if expected_duration else 0.0
                )
                has_filesize_warning = any(
                    "filesize and duration do not match" in text for text in warning_texts
                )
                has_non_monotonic_warning = any(
                    "non-monotonic dts" in text for text in warning_texts
                )
                if (
                    has_filesize_warning
                    and duration_mismatch_ratio <= FILESIZE_MISMATCH_DRIFT_TOLERANCE
                ):
                    duration_mismatch_tolerated = True
                    effective_duration = converted_duration
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] tolerating duration drift for {source}: "
                            f"expected {expected_duration:.2f}s vs converted "
                            f"{converted_duration:.2f}s (ratio {duration_mismatch_ratio:.4f})",
                            is_error=True,
                        )
                    )
                    duration_error = None
                elif (
                    has_non_monotonic_warning
                    and NON_MONOTONIC_MIN_RATIO <= duration_ratio <= NON_MONOTONIC_MAX_RATIO
                ):
                    duration_mismatch_tolerated = True
                    effective_duration = converted_duration
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] tolerating non-monotonic timestamp drift "
                            f"for {source}: expected {expected_duration:.2f}s vs converted "
                            f"{converted_duration:.2f}s (ratio {duration_ratio:.4f})",
                            is_error=True,
                        )
                    )
                    duration_error = None
                elif ffprobe_path:
                    source_duration, source_duration_error = probe_media_duration_seconds(
                        source,
                        ffprobe=ffprobe_path,
                    )
                    if source_duration is not None:
                        source_tolerance = max(
                            DURATION_TOLERANCE_MIN_SECONDS,
                            source_duration * DURATION_TOLERANCE_PERCENTAGE,
                        )
                        if abs(converted_duration - source_duration) <= source_tolerance:
                            duration_mismatch_tolerated = True
                            effective_duration = converted_duration
                            messages.append(
                                ConversionLogMessage(
                                    f"[stage_audio_files] catalog duration {expected_duration:.2f}s "
                                    f"differs from measured source duration {source_duration:.2f}s; "
                                    f"accepting converted value {converted_duration:.2f}s.",
                                    is_error=True,
                                )
                            )
                            duration_error = None
                    elif source_duration_error:
                        messages.append(
                            ConversionLogMessage(
                                f"[stage_audio_files] unable to verify source duration for "
                                f"{source}: {source_duration_error}",
                                is_error=True,
                            )
                        )

            if duration_error is not None:
                if (
                    uses_async_filter
                    and len(filter_variants) > variant_index + 1
                    and aresample_compensation_failed
                ):
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] timestamp compensation failed for {source}; "
                            f"retrying without async filter",
                            is_error=True,
                        )
                    )
                    retry_without_async_triggered = True
                    continue

                if staged_path.exists():
                    staged_path.unlink()
                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] conversion duration check failed for {source}: "
                        f"{duration_error}",
                        is_error=True,
                    )
                )
                failure_lines = [
                    f"FAILURE {row.sha256}",
                    f"Source: {source}",
                    f"Expected output: {staged_path}",
                    f"Command: {shlex.join(ffmpeg_cmd)}",
                    f"Reason: {duration_error}",
                    "ExitCode: 0",
                ]
                if notice := log_notice_state.take_notice():
                    messages.append(ConversionLogMessage(notice, is_error=True))
                return ConversionResult(
                    None,
                    SkippedEntry(
                        row.sha256,
                        source,
                        f"conversion produced invalid output ({duration_error})",
                    ),
                    tuple(messages),
                    tuple(failure_lines),
                )

            messages.append(
                ConversionLogMessage(f"[stage_audio_files] converted {source} -> {staged_path}")
            )
            log_lines = [
                f"SUCCESS {row.sha256}",
                f"Source: {source}",
                f"Output: {staged_path}",
                f"Command: {shlex.join(ffmpeg_cmd)}",
            ]
            if duration_mismatch_tolerated and converted_duration is not None:
                log_lines.append(
                    f"DurationDrift: expected {expected_duration:.2f}s -> converted "
                    f"{converted_duration:.2f}s (ratio {duration_mismatch_ratio:.6f})"
                )
            log_lines.append("ExitCode: 0")
            log_lines.append(f"NormalizationApplied: {'yes' if normalized else 'no'}")
            log_lines.append(f"AsyncFilterUsed: {'yes' if uses_async_filter else 'no'}")
            if retry_without_async_triggered and not uses_async_filter:
                log_lines.append("AsyncFallback: yes")

            needs_compression_retry = False
            if aggressive_normalization and normalized and has_norm_data:
                try:
                    lufs_check_cmd = [
                        ffmpeg_binary,
                        "-nostdin",
                        "-hide_banner",
                        "-i",
                        str(staged_path),
                        "-af",
                        "loudnorm=print_format=json",
                        "-f",
                        "null",
                        "-",
                    ]
                    lufs_result = subprocess.run(
                        lufs_check_cmd,
                        capture_output=True,
                        timeout=None,
                    )
                    lufs_stderr = safe_decode(lufs_result.stderr)

                    stderr_lines = lufs_stderr.splitlines()
                    json_start = -1
                    json_end = -1

                    for i in range(len(stderr_lines) - 1, -1, -1):
                        line = stderr_lines[i].strip()
                        if json_end == -1 and line.endswith("}"):
                            json_end = i
                        if json_start == -1 and line.startswith("{"):
                            json_start = i
                            if json_end >= json_start:
                                break

                    if json_start >= 0 and json_end >= 0 and json_end >= json_start:
                        json_text = "\n".join(stderr_lines[json_start : json_end + 1])
                        loudness_data = json.loads(json_text)
                        measured_lufs = loudness_data.get("input_i")

                        if measured_lufs and determine_needs_normalization(measured_lufs) == "yes":
                            needs_compression_retry = True
                            messages.append(
                                ConversionLogMessage(
                                    f"[stage_audio_files] linear normalization achieved "
                                    f"{measured_lufs} LUFS (target: -20 to -12), retrying "
                                    f"with compression (linear=false)"
                                )
                            )
                except Exception as check_exc:
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] LUFS check failed for {staged_path}: {check_exc}",
                            is_error=True,
                        )
                    )

            if needs_compression_retry:
                compression_filter_components = []

                if apply_declipping:
                    compression_filter_components.append(
                        "adeclip=window=55:overlap=75:arorder=8:threshold=10:method=a"
                    )

                compression_filter_components.append(
                    f"loudnorm=I={LOUDNESS_TARGET_LUFS}:LRA={LOUDNESS_RANGE_LU}:"
                    f"tp={TRUE_PEAK_TARGET_DBTP}:"
                    f"measured_I={row.integrated_loudness_lufs}:"
                    f"measured_LRA={row.loudness_range_lu}:"
                    f"measured_tp={row.true_peak_db}:"
                    f"measured_thresh={row.input_thresh}:"
                    f"offset={row.target_offset}:"
                    f"linear=false"
                )

                compression_filter_components.append(aresample_component)
                compression_filter = ",".join(compression_filter_components)

                retry_cmd = [
                    ffmpeg_binary,
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    str(input_for_normalization),
                    "-vn",
                    "-af",
                    compression_filter,
                    "-ac",
                    str(TARGET_CHANNELS),
                    "-ar",
                    str(config.audio.sample_rate),
                    "-c:a",
                    "pcm_s16le",
                    "-f",
                    "wav",
                    str(staged_path),
                ]

                messages.append(
                    ConversionLogMessage(
                        f"[stage_audio_files] compression retry command: {shlex.join(retry_cmd)}"
                    )
                )

                try:
                    retry_result = subprocess.run(retry_cmd, capture_output=True)
                    if retry_result.returncode == 0:
                        messages.append(
                            ConversionLogMessage(
                                f"[stage_audio_files] compression retry succeeded for {source}"
                            )
                        )
                        log_lines.append("CompressionRetry: yes")
                    else:
                        retry_stderr = safe_decode(retry_result.stderr)
                        messages.append(
                            ConversionLogMessage(
                                f"[stage_audio_files] compression retry failed for {source}, "
                                f"keeping linear-normalized result: {retry_stderr[:100]}",
                                is_error=True,
                            )
                        )
                        log_lines.append("CompressionRetry: failed (kept linear result)")
                except FileNotFoundError as retry_exc:
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] compression retry failed for {source}, "
                            f"keeping linear-normalized result: {retry_exc}",
                            is_error=True,
                        )
                    )
                    log_lines.append("CompressionRetry: failed (kept linear result)")

            analysis_metrics: AudioQualityMetrics | None = None
            file_size_bytes = 0
            if include_audio_analysis:
                try:
                    file_size_bytes = staged_path.stat().st_size
                except OSError as size_exc:
                    file_size_bytes = 0
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] unable to stat staged file {staged_path}: {size_exc}",
                            is_error=True,
                        )
                    )

                try:
                    analysis_metrics = analyze_audio_file(
                        staged_path,
                        timeout=None,
                        ffmpeg_binary=analysis_ffmpeg_bin,
                        ffprobe_binary=analysis_ffprobe_bin,
                    )
                except Exception as analysis_exc:
                    messages.append(
                        ConversionLogMessage(
                            f"[stage_audio_files] audio analysis failed for {staged_path}: "
                            f"{analysis_exc}",
                            is_error=True,
                        )
                    )
                    if not continue_on_error:
                        return ConversionResult(
                            None,
                            SkippedEntry(
                                row.sha256, source, f"audio analysis failed: {analysis_exc}"
                            ),
                            tuple(messages),
                            tuple(log_lines),
                        )

            return ConversionResult(
                PreparedEntry(
                    row.sha256,
                    source,
                    staged_path,
                    "convert",
                    effective_duration,
                    normalized,
                ),
                None,
                tuple(messages),
                tuple(log_lines),
                metrics=analysis_metrics,
                size_bytes=file_size_bytes,
            )

        failure_lines = [
            f"FAILURE {row.sha256}",
            f"Source: {source}",
            "Reason: conversion failed after async fallback",
        ]
        return ConversionResult(
            None,
            SkippedEntry(row.sha256, source, "conversion failed after async fallback"),
            tuple(messages),
            tuple(failure_lines),
        )
    finally:
        temp_wav.unlink(missing_ok=True)
