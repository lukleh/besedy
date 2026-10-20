"""Training data from human corrections (ADR 0012).

The web application decides which decoded chunks may train a model and lists
them with the revision of every span (``GET /api/internal/correction/
training-export``). This module rebuilds each eligible chunk exactly as the
model was given it, the chunk's VAD regions concatenated from the staged
16 kHz WAV, and labels it with its spans' corrected texts in order.

Everything that decides what trains a model lives in export code and may
change: the web's eligibility policy, the test recordings named in a config
file, and whether fillers stay in labels.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import wave
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from besedy.lib import correction_segmentation as cs
from besedy.lib.catalog.manager import source_file_sha256
from besedy.lib.correction_guard import map_recorded_path

DATASET_SCHEMA_VERSION = 1

# The spellings the correction guide fixes for fillers (ADR 0012). A filler
# takes the punctuation written right after it along: "Ehm?" leaves no "?".
FILLERS = ("ehm", "eee", "hm", "mhm")
_FILLER = re.compile(
    r"(?<![\w-])(?:" + "|".join(FILLERS) + r")(?![\w-])[,.…?!:;]*", flags=re.IGNORECASE
)


class TrainingExportError(RuntimeError):
    """The export cannot be turned into a dataset as it stands."""


def fetch_training_export(
    catalog_id: str,
    *,
    base_url: str | None = None,
    bearer_token: str | None = None,
    min_heard_fraction: float | None = None,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Ask the web application which corrected chunks may train a model."""
    base_url = (base_url or os.getenv("BESEDY_INTERNAL_BASE_URL", "")).strip().rstrip("/")
    bearer_token = (bearer_token or os.getenv("BESEDY_JOB_SERVICE_SECRET", "")).strip()
    if not base_url or not bearer_token:
        raise TrainingExportError(
            "BESEDY_INTERNAL_BASE_URL and BESEDY_JOB_SERVICE_SECRET are required "
            "to fetch the training export from the web application"
        )
    query = {"catalogId": catalog_id}
    if min_heard_fraction is not None:
        query["minHeardFraction"] = str(min_heard_fraction)
    url = f"{base_url}/api/internal/correction/training-export?{urllib_parse.urlencode(query)}"
    request = urllib_request.Request(url, headers={"Authorization": f"Bearer {bearer_token}"})
    with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def strip_fillers(text: str) -> str:
    """Remove the fixed filler spellings, leaving the rest of the text as it was."""
    return cs.normalize_span_text(_FILLER.sub(" ", text))


def load_test_recordings(path: Path | None) -> set[str]:
    """Audio hashes set aside for testing: a JSON list or one hash per line."""
    if path is None:
        return set()
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    hashes = json.loads(raw) if raw.startswith("[") else raw.split()
    return {str(value).strip() for value in hashes if str(value).strip()}


@dataclass
class DatasetSummary:
    workspaces: int = 0
    chunks_written: int = 0
    chunks_excluded: int = 0
    seconds: float = 0.0
    splits: Counter[str] = field(default_factory=Counter)
    exclusion_reasons: Counter[str] = field(default_factory=Counter)

    def to_json(self) -> dict[str, Any]:
        return {
            "workspaces": self.workspaces,
            "chunks_written": self.chunks_written,
            "chunks_excluded": self.chunks_excluded,
            "hours": round(self.seconds / 3600, 3),
            "splits": dict(self.splits),
            "exclusion_reasons": dict(self.exclusion_reasons.most_common()),
        }


def _reason_kind(reason: str) -> str:
    """'span 12 is flagged UNCLEAR' -> 'is flagged UNCLEAR', for counting."""
    return re.sub(r"^span \d+ ", "", reason)


def build_dataset(
    export: Mapping[str, Any],
    corrections_root: Path,
    output_dir: Path,
    *,
    test_recordings: Iterable[str] = (),
    keep_fillers: bool = True,
    verify_audio_hash: bool = False,
    path_map: Mapping[str, str] | None = None,
) -> DatasetSummary:
    """Write one WAV per eligible chunk and a manifest of labels and provenance."""
    if export.get("schemaVersion") != 1:
        raise TrainingExportError(f"Unknown training export schema {export.get('schemaVersion')!r}")
    test = set(test_recordings)
    audio_dir = output_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    summary = DatasetSummary()
    rows: list[dict[str, Any]] = []

    for workspace in export.get("workspaces") or []:
        summary.workspaces += 1
        catalog = export["catalogId"]
        source_path = (
            corrections_root
            / f"corrections_{catalog}"
            / workspace["workspaceId"]
            / "source"
            / "transcript.json"
        )
        source_bytes = source_path.read_bytes()
        if hashlib.sha256(source_bytes).hexdigest() != workspace["sourceFingerprint"]:
            raise TrainingExportError(f"Frozen source of {workspace['workspaceId']} changed")
        if workspace["segmentationVersion"] != cs.SEGMENTATION_VERSION:
            raise TrainingExportError(
                f"Workspace {workspace['workspaceId']} was cut with {workspace['segmentationVersion']}, "
                f"this code rebuilds {cs.SEGMENTATION_VERSION}"
            )
        source = json.loads(source_bytes.decode("utf-8"))
        clips = source["meta"]["generation_params"]["transcription_options"]["clip_timestamps"]
        regions = [cs.Region(int(c["start"]), int(c["end"])) for c in clips]
        chunks = cs.build_chunks(regions)

        staged = workspace["stagedAudio"]
        audio_path = map_recorded_path(staged["path"], path_map or {})
        if audio_path.stat().st_size != int(staged["size"]):
            raise TrainingExportError(f"Staged audio {audio_path} changed size")
        if verify_audio_hash:
            if source_file_sha256(audio_path) != staged["sha256"]:
                raise TrainingExportError(f"Staged audio {audio_path} changed")

        split = "test" if workspace["audioHash"] in test else "train"
        with wave.open(str(audio_path), "rb") as source_wav:
            if (
                source_wav.getframerate() != cs.SAMPLE_RATE
                or source_wav.getnchannels() != 1
                or source_wav.getsampwidth() != 2
            ):
                raise TrainingExportError(f"Staged audio {audio_path} is not 16 kHz mono PCM16")
            for chunk in workspace["chunks"]:
                if not chunk["eligible"]:
                    summary.chunks_excluded += 1
                    summary.exclusion_reasons.update({_reason_kind(r) for r in chunk["reasons"]})
                    continue
                indices = chunks[chunk["chunk"]]
                covered = [
                    i
                    for span in chunk["spans"]
                    for i in range(span["firstRegion"], span["lastRegion"] + 1)
                ]
                if covered != indices:
                    raise TrainingExportError(
                        f"Spans of chunk {chunk['chunk']} in {workspace['workspaceId']} do not cover its regions"
                    )
                frames = bytearray()
                for index in indices:
                    source_wav.setpos(regions[index].start)
                    frames += source_wav.readframes(regions[index].end - regions[index].start)
                text = cs.normalize_span_text(" ".join(span["text"] for span in chunk["spans"]))
                if not keep_fillers:
                    text = strip_fillers(text)

                name = f"{workspace['audioHash'][:16]}_{chunk['chunk']:05d}.wav"
                with wave.open(str(audio_dir / name), "wb") as out:
                    out.setnchannels(1)
                    out.setsampwidth(2)
                    out.setframerate(cs.SAMPLE_RATE)
                    out.writeframes(bytes(frames))
                duration = len(frames) / 2 / cs.SAMPLE_RATE
                rows.append(
                    {
                        "audio": f"audio/{name}",
                        "text": text,
                        "duration": round(duration, 3),
                        "split": split,
                        "audio_hash": workspace["audioHash"],
                        "workspace_id": workspace["workspaceId"],
                        "chunk": chunk["chunk"],
                        "revision_ids": [span["revisionId"] for span in chunk["spans"]],
                        "source_backend": workspace["sourceBackend"],
                    }
                )
                summary.chunks_written += 1
                summary.seconds += duration
                summary.splits[split] += 1

    with (output_dir / "manifest.jsonl").open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    (output_dir / "export.json").write_text(
        json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / "dataset.json").write_text(
        json.dumps(
            {
                "schema_version": DATASET_SCHEMA_VERSION,
                "catalog_id": export["catalogId"],
                "exported_at": export["exportedAt"],
                "policy": {
                    **export.get("policy", {}),
                    "keep_fillers": keep_fillers,
                    "test_recordings": sorted(test),
                },
                "summary": summary.to_json(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return summary
