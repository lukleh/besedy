"""Derived measurements are reused only for the unchanged staged file."""

from __future__ import annotations

import csv
import os
from pathlib import Path

import pytest

from besedy.lib.audio import normalize_stage_helpers as stage_helpers
from besedy.lib.audio.quality import AudioQualityMetrics
from besedy.lib.audio.staged_measurements import (
    MEASUREMENT_FINGERPRINT_COLUMN,
    load_staged_measurements,
    staged_measurement_fingerprint,
)
from besedy.lib.audio.types import ManifestWriter, PreparedEntry
from besedy.lib.workflow.common import CsvAudioRow
from tests.helpers.audio import create_silent_wav, create_tone_wav

HASH = "a" * 64


def _metrics(loudness: str = "-16") -> AudioQualityMetrics:
    return AudioQualityMetrics(
        sample_rate="16000",
        channels="1",
        bitrate_kbps="256",
        integrated_loudness_lufs=loudness,
        true_peak_db="-3",
        loudness_range_lu="4",
        input_thresh="-26",
        target_offset="0",
        needs_normalization="no",
    )


@pytest.fixture
def cached_audio(tmp_path: Path):
    staged = create_silent_wav(tmp_path / f"{HASH}.wav")
    manifest_path = tmp_path / "normalized.csv"
    manifest = ManifestWriter(manifest_path, include_analysis=True)
    try:
        manifest.write_entry(
            PreparedEntry(HASH, tmp_path / "source.wav", staged, "convert", 1.0, True),
            size_bytes=staged.stat().st_size,
            metrics=_metrics(),
            measurement_fingerprint=staged_measurement_fingerprint(staged),
        )
    finally:
        manifest.close()
    return staged, manifest_path


@pytest.mark.parametrize(
    "change",
    [
        "unchanged",
        "edit_preserving_mtime",
        "replace_preserving_mtime",
        "legacy_source_metrics",
        "invalid_metric",
        "missing_metric",
        "other_audio_hash",
    ],
)
def test_cache_checks_measurement_provenance_and_all_fields(
    cached_audio, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    staged, manifest_path = cached_audio
    before = staged.stat()
    if change == "edit_preserving_mtime":
        data = bytearray(staged.read_bytes())
        data[-1] = 1
        staged.write_bytes(data)
        os.utime(staged, ns=(before.st_atime_ns, before.st_mtime_ns))
        assert staged.stat().st_ctime_ns != before.st_ctime_ns
    elif change == "replace_preserving_mtime":
        replacement = create_tone_wav(tmp_path / "replacement.wav")
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        replacement.replace(staged)
        assert staged.stat().st_ino != before.st_ino
    elif change not in {"unchanged"}:
        with manifest_path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            fieldnames = reader.fieldnames
            rows = list(reader)
        if change == "legacy_source_metrics":
            rows[0][MEASUREMENT_FINGERPRINT_COLUMN] = ""
            rows[0]["integrated_loudness_lufs"] = "-40"
            rows[0]["needs_normalization"] = "yes"
        elif change == "invalid_metric":
            rows[0]["true_peak_db"] = "not a number"
        elif change == "missing_metric":
            rows[0]["sample_rate"] = ""
        elif change == "other_audio_hash":
            rows[0]["Hash"] = "b" * 64
        with manifest_path.open("w", newline="", encoding="utf-8") as handle:
            assert fieldnames is not None
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    analyzed: list[Path] = []

    def analyze(path, **_kwargs):
        analyzed.append(path)
        return _metrics("-17")

    monkeypatch.setattr(stage_helpers, "analyze_audio_file", analyze)
    cache = load_staged_measurements(manifest_path)
    _entry, size, measurements = stage_helpers.reuse_existing_staged_entry(
        row=CsvAudioRow(HASH, str(tmp_path / "source.wav"), duration_seconds=1.0),
        source=tmp_path / "source.wav",
        staged_path=staged,
        duration_seconds=1.0,
        include_audio_analysis=True,
        analysis_ffmpeg_bin="ffmpeg",
        analysis_ffprobe_bin="ffprobe",
        continue_on_error=False,
        cached_measurements=cache.get((HASH, staged)),
    )

    assert measurements is not None
    assert size == staged.stat().st_size
    assert measurements.fingerprint == staged_measurement_fingerprint(staged)
    assert analyzed == ([] if change == "unchanged" else [staged])
    assert measurements.metrics.integrated_loudness_lufs == (
        "-16" if change == "unchanged" else "-17"
    )


def test_changes_during_analysis_are_not_marked_as_fresh(
    cached_audio, monkeypatch: pytest.MonkeyPatch
) -> None:
    staged, _manifest = cached_audio

    def analyze(path, **_kwargs):
        path.write_bytes(path.read_bytes() + b"changed")
        return _metrics()

    monkeypatch.setattr(stage_helpers, "analyze_audio_file", analyze)
    with pytest.raises(RuntimeError, match="changed while measuring"):
        stage_helpers.reuse_existing_staged_entry(
            row=CsvAudioRow(HASH, str(staged), duration_seconds=1.0),
            source=staged,
            staged_path=staged,
            duration_seconds=1.0,
            include_audio_analysis=True,
            analysis_ffmpeg_bin="ffmpeg",
            analysis_ffprobe_bin="ffprobe",
            continue_on_error=False,
        )
