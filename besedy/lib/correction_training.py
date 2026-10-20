"""Training data from human corrections (ADR 0012).

The web application decides which decoded chunks may train a model and lists
them with the revision of every span (``GET /api/internal/correction/
training-export``). This module rebuilds each eligible chunk exactly as the
model was given it, the chunk's VAD regions concatenated from the staged
16 kHz WAV, and labels it with its spans' corrected texts in order.

Everything that decides what trains a model lives in export code and may
change: the web's eligibility policy, the test recordings listed in
``contracts/correction-test-recordings.json``, and whether fillers stay in
labels.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import wave
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from besedy.lib import correction_segmentation as cs
from besedy.lib.catalog.manager import source_file_sha256
from besedy.lib.correction_guard import map_recorded_path

LOGGER = logging.getLogger(__name__)

DATASET_SCHEMA_VERSION = 1

# Audio hashes set aside for testing, per catalog, shared with the web app.
DEFAULT_TEST_RECORDINGS_PATH = (
    Path(__file__).resolve().parents[2] / "contracts" / "correction-test-recordings.json"
)
TEST_RECORDINGS_VERSION = 1
_AUDIO_HASH = re.compile(r"^[0-9a-f]{64}$")

# The spellings the correction guide fixes for fillers (ADR 0012). A filler
# takes the punctuation written right after it along ("Ehm? Ano." leaves
# "Ano."), except that a filler closing a sentence hands its sentence
# punctuation to the words before it and takes the comma or slash that joined
# it to them instead ("ano, hm?" leaves "ano?").
FILLERS = ("ehm", "eee", "hm", "mhm")
_FILLER_WORD = r"(?<![\w-])(?:" + "|".join(FILLERS) + r")(?![\w-])"
_SENTENCE_END = r"[.…?!]"
_TRAILING_FILLER = re.compile(
    r"\s*[,/]\s*" + _FILLER_WORD + r"\s*(?=" + _SENTENCE_END + r"|$)", flags=re.IGNORECASE
)
_FILLER = re.compile(_FILLER_WORD + r"[,.…?!:;/]*", flags=re.IGNORECASE)
_EMPTY_PAIR = re.compile(r"\(\s*\)|\[\s*\]|\"\s*\"|„\s*“|“\s*”|‚\s*‘|‘\s*’")
STRIP_FILLERS_NOTE = (
    "ehm/eee/hm/mhm removed with their punctuation; a word that followed a "
    "sentence-initial filler keeps its lowercase"
)


class TrainingExportError(RuntimeError):
    """The export cannot be turned into a dataset as it stands."""


def fetch_training_export(
    catalog_id: str,
    *,
    base_url: str | None = None,
    bearer_token: str | None = None,
    min_heard_fraction: float | None = None,
    audio_hash: str | None = None,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Ask the web application which corrected chunks may train a model.

    ``audio_hash`` limits the answer to one recording's workspace, so a large
    catalog can be fetched piecewise and joined with `merge_training_exports`.
    """
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
    if audio_hash is not None:
        query["audioHash"] = audio_hash
    url = f"{base_url}/api/internal/correction/training-export?{urllib_parse.urlencode(query)}"
    request = urllib_request.Request(url, headers={"Authorization": f"Bearer {bearer_token}"})
    with urllib_request.urlopen(request, timeout=timeout_seconds) as response:
        return json.loads(response.read().decode("utf-8"))


def strip_fillers(text: str) -> str:
    """Remove the fixed filler spellings and the punctuation left dangling by that."""
    text = _TRAILING_FILLER.sub("", text)
    text = _FILLER.sub(" ", text)
    text = _EMPTY_PAIR.sub(" ", text)
    return cs.normalize_span_text(text)


def merge_training_exports(exports: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """One export from the per-recording fetches of a catalog; the first sets the policy."""
    if not exports:
        raise TrainingExportError("No training export to merge")
    first = exports[0]
    for other in exports[1:]:
        if other.get("catalogId") != first.get("catalogId"):
            raise TrainingExportError("Training exports of different catalogs cannot be merged")
        if other.get("schemaVersion") != first.get("schemaVersion"):
            raise TrainingExportError("Training exports of different schemas cannot be merged")
    merged = dict(first)
    merged["workspaces"] = [w for export in exports for w in export.get("workspaces") or []]
    return merged


def load_test_recordings(path: Path, catalog_id: str) -> set[str]:
    """Audio hashes set aside for testing.

    The repository file ``contracts/correction-test-recordings.json`` maps a
    catalog to its hashes; a JSON list or one hash per line names them for any
    catalog. A catalog the repository file does not name is refused rather
    than read as having no test recordings: a recording trained on can never
    become a test recording again, so the list is chosen before any export.
    An explicit empty list says the catalog has none on purpose.
    """
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        return set()
    if raw.startswith("{"):
        document = json.loads(raw)
        if document.get("version") != TEST_RECORDINGS_VERSION:
            raise TrainingExportError(
                f"{path} is test recordings version {document.get('version')!r}, "
                f"expected {TEST_RECORDINGS_VERSION}"
            )
        catalogs = document.get("catalogs", {})
        if catalog_id not in catalogs:
            raise TrainingExportError(
                f"{path} names no test recordings for catalog {catalog_id}. Choose them before "
                "the first export (an empty list if the catalog has none on purpose), or pass "
                "--no-test-recordings for an experiment"
            )
        hashes = catalogs[catalog_id]
    else:
        hashes = json.loads(raw) if raw.startswith("[") else raw.split()
    result = {str(value).strip() for value in hashes if str(value).strip()}
    for value in result:
        if not _AUDIO_HASH.match(value):
            raise TrainingExportError(f"{path} names {value!r}, not a 64-character audio hash")
    return result


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


# An eligible chunk whose spans do not add up to its regions; the export is
# inconsistent with the frozen source, so the chunk is left out rather than
# rebuilt from a guess.
SPAN_COVERAGE_MISMATCH = "SPAN_COVERAGE_MISMATCH"


def _open_staged_wav(audio_path: Path) -> wave.Wave_read:
    try:
        source_wav = wave.open(str(audio_path), "rb")
    except (wave.Error, EOFError) as exc:
        raise TrainingExportError(
            f"Staged audio {audio_path} is not a readable WAV: {exc}"
        ) from exc
    if (
        source_wav.getframerate() != cs.SAMPLE_RATE
        or source_wav.getnchannels() != 1
        or source_wav.getsampwidth() != 2
    ):
        source_wav.close()
        raise TrainingExportError(f"Staged audio {audio_path} is not 16 kHz mono PCM16")
    return source_wav


def _read_regions(
    source_wav: wave.Wave_read,
    audio_path: Path,
    regions: Sequence[cs.Region],
    indices: Iterable[int],
) -> bytes:
    """The given regions' samples, in order, with no silence between them."""
    frames = bytearray()
    total = source_wav.getnframes()
    for index in indices:
        region = regions[index]
        if region.end > total or region.start < 0 or region.start > region.end:
            raise TrainingExportError(
                f"Region {index} ({region.start}-{region.end} samples) of {audio_path} "
                f"lies outside its {total} frames"
            )
        try:
            source_wav.setpos(region.start)
            frames += source_wav.readframes(region.end - region.start)
        except (wave.Error, EOFError) as exc:
            raise TrainingExportError(
                f"Region {index} of {audio_path} could not be read: {exc}"
            ) from exc
    return bytes(frames)


def build_dataset(
    export: Mapping[str, Any],
    corrections_root: Path,
    output_dir: Path,
    *,
    test_recordings: Iterable[str] = (),
    test_recordings_source: str | None = None,
    keep_fillers: bool = True,
    verify_audio_hash: bool = True,
    path_map: Mapping[str, str] | None = None,
) -> DatasetSummary:
    """Write one WAV per eligible chunk and a manifest of labels and provenance.

    ``test_recordings_source`` names where the test list came from, for
    ``dataset.json``; ``verify_audio_hash`` hashes every staged WAV and refuses
    one that no longer matches what the web recorded.
    """
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
        if verify_audio_hash and source_file_sha256(audio_path) != staged["sha256"]:
            raise TrainingExportError(f"Staged audio {audio_path} changed")

        split = "test" if workspace["audioHash"] in test else "train"
        with _open_staged_wav(audio_path) as source_wav:
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
                    LOGGER.warning(
                        "Spans of chunk %d in workspace %s do not cover its regions; excluded",
                        chunk["chunk"],
                        workspace["workspaceId"],
                    )
                    summary.chunks_excluded += 1
                    summary.exclusion_reasons[SPAN_COVERAGE_MISMATCH] += 1
                    continue
                frames = _read_regions(source_wav, audio_path, regions, indices)
                text = cs.normalize_span_text(" ".join(span["text"] for span in chunk["spans"]))
                if not keep_fillers:
                    text = strip_fillers(text)

                name = f"{workspace['audioHash'][:16]}_{chunk['chunk']:05d}.wav"
                with wave.open(str(audio_dir / name), "wb") as out:
                    out.setnchannels(1)
                    out.setsampwidth(2)
                    out.setframerate(cs.SAMPLE_RATE)
                    out.writeframes(frames)
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
                    "strip_fillers": not keep_fillers,
                    "strip_fillers_note": STRIP_FILLERS_NOTE if not keep_fillers else None,
                    "test_recordings": sorted(test),
                    "test_recordings_source": test_recordings_source,
                },
                "summary": summary.to_json(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return summary
