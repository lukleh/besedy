"""Validation helpers for staged audio files."""

from __future__ import annotations

import sys
from collections.abc import Sequence
from pathlib import Path

from besedy.lib.audio.probe import audio_is_wav_mono_16k, probe_primary_audio_stream
from besedy.lib.audio.types import PreparedEntry
from besedy.lib.workflow.common import CsvAudioRow, resolve_unicode_path


def validate_staged_audio(
    rows: Sequence[CsvAudioRow],
) -> tuple[list[PreparedEntry], list[tuple[str, Path, str]]]:
    """Validate that audio files are staged correctly (16kHz mono WAV)."""

    prepared: list[PreparedEntry] = []
    errors: list[tuple[str, Path, str]] = []
    for row in rows:
        source_path, _resolved, exists = resolve_unicode_path(row.full_path)
        if not exists:
            errors.append((row.sha256, source_path, "file not found"))
            continue
        if not audio_is_wav_mono_16k(source_path):
            metadata = probe_primary_audio_stream(source_path)
            if metadata is None:
                reason = "unable to probe audio format"
            else:
                sample_rate, channels = metadata
                reason = f"expected 16kHz mono WAV, got {sample_rate}Hz {channels}ch"
            errors.append((row.sha256, source_path, reason))
            continue

        prepared.append(
            PreparedEntry(
                sha256=row.sha256,
                source=source_path,
                staged=source_path,
                action="existing",
                duration_seconds=row.duration_seconds or 0.0,
            )
        )
    return prepared, errors


def print_validation_errors(errors: Sequence[tuple[str, Path, str]], mode_label: str) -> None:
    """Print validation errors for staged audio."""

    print(f"\n{'=' * 80}", file=sys.stderr)
    print(f"ERROR: Found {len(errors)} file(s) with invalid staged audio", file=sys.stderr)
    print(f"{'=' * 80}\n", file=sys.stderr)
    print(
        f"The '{mode_label}' command requires audio normalized via 'stage-audio' (16kHz, mono, WAV).",
        file=sys.stderr,
    )
    print(
        f"Run 'just catalog stage-audio --csv <catalog>' before '{mode_label}'.\n", file=sys.stderr
    )
    print("Invalid files (showing first 10):", file=sys.stderr)
    for sha256, path, reason in errors[:10]:
        print(f"  - {sha256}: {reason}", file=sys.stderr)
        print(f"    Path: {path}", file=sys.stderr)
    remaining = len(errors) - 10
    if remaining > 0:
        print(f"  ... and {remaining} more", file=sys.stderr)
    print(f"\n{'=' * 80}\n", file=sys.stderr)
