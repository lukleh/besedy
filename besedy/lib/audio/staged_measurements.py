"""Freshness of derived staged-audio measurements, not recording identity."""

from __future__ import annotations

import csv
import logging
import math
from dataclasses import dataclass
from pathlib import Path

from besedy.config.settings import config
from besedy.lib.audio.quality import (
    AUDIO_QUALITY_COLUMNS,
    AudioQualityMetrics,
    determine_needs_normalization,
)

MEASUREMENT_FINGERPRINT_COLUMN = "staged_measurement_fingerprint"
_FINGERPRINT_VERSION = "v1"
_LOUDNESS_FIELDS = (
    "integrated_loudness_lufs",
    "true_peak_db",
    "loudness_range_lu",
    "input_thresh",
    "target_offset",
)


def staged_measurement_fingerprint(path: Path) -> str:
    """Track ordinary edits and replacements, including edits preserving mtime."""
    stat = path.stat()
    return ":".join(
        str(value)
        for value in (
            _FINGERPRINT_VERSION,
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
        )
    )


@dataclass(frozen=True)
class StagedAudioMeasurements:
    metrics: AudioQualityMetrics
    fingerprint: str

    def matches(self, path: Path) -> bool:
        return self.fingerprint == staged_measurement_fingerprint(path)


def load_staged_measurements(path: Path) -> dict[tuple[str, Path], StagedAudioMeasurements]:
    """Reuse only complete marked rows; legacy or damaged rows are remeasured."""
    cached: dict[tuple[str, Path], StagedAudioMeasurements] = {}
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                try:
                    fingerprint = row[MEASUREMENT_FINGERPRINT_COLUMN]
                    parts = fingerprint.split(":")
                    if len(parts) != 6 or parts[0] != _FINGERPRINT_VERSION:
                        continue
                    if any(int(value) < 0 for value in parts[1:]):
                        continue
                    if int(row["Size (bytes)"]) != int(parts[3]):
                        continue
                    values = {column: row[column] for column in AUDIO_QUALITY_COLUMNS}
                    if any(not isinstance(value, str) for value in values.values()):
                        continue
                    if any(
                        not values[name] or math.isnan(float(values[name]))
                        for name in _LOUDNESS_FIELDS
                    ):
                        continue
                    if int(values["sample_rate"]) != config.audio.sample_rate:
                        continue
                    if int(values["channels"]) != 1:
                        continue
                    bitrate = float(values["bitrate_kbps"])
                    if not math.isfinite(bitrate) or bitrate <= 0:
                        continue
                    if values["needs_normalization"] != determine_needs_normalization(
                        values["integrated_loudness_lufs"]
                    ):
                        continue
                    audio_hash = row["Hash"].strip().lower()
                    staged_path = Path(row["Full Path"]).expanduser().absolute()
                    if not audio_hash or not row["Full Path"].strip():
                        continue
                    cached[audio_hash, staged_path] = StagedAudioMeasurements(
                        AudioQualityMetrics(**values), fingerprint
                    )
                except (KeyError, ValueError, TypeError, AttributeError):
                    continue
    except FileNotFoundError:
        pass
    except (OSError, UnicodeError, csv.Error) as exc:
        logging.warning("Cannot reuse staged-audio measurements from %s: %s", path, exc)
    return cached
