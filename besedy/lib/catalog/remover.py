"""Hash-scoped removal of one recording and every artifact derived from it.

`catalog clean` reacts to source files that went missing; this module is the
inverse: given a recording that is still fully present, take it out of the
catalog CSVs and delete its staged/archived audio, transcripts, diarization and
speaker embeddings. RAG chunks and speaker clusters are not touched here - the
incremental ColBERT sync prunes hashes whose transcripts disappeared and
`cluster-speakers` rebuilds from the remaining embeddings, so a `run-pipeline`
after this removal brings those derived stores back in line.
"""

from __future__ import annotations

import csv
import re
import shutil
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from besedy.lib.catalog.cleaner import (
    _get_transcript_search_roots,
    find_diarization_dirs,
    find_transcript_dirs,
)
from besedy.lib.catalog.manager import filter_catalog_rows, load_csv, resolve_hash_column
from besedy.lib.data.atomic_io import atomic_path

SPEAKER_EMBEDDINGS_DIRNAME = "speaker_embeddings"
AUDIO_HASH_SIDECAR_SUFFIX = ".audiohash"
# Derived catalog generations that carry one row per hash, in the order the
# pipeline produces them. Missing files are simply skipped.
CATALOG_CSV_SUFFIXES: tuple[str, ...] = (
    "",
    "_loudness",
    "_loudness_normalized",
    "_loudness_archived",
    "_duplicates",
    "_joined",
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class InvalidAudioHashError(ValueError):
    """Raised when the hash is not a full lowercase SHA-256 hex digest."""


def normalize_audio_hash(value: str) -> str:
    rendered = value.strip().lower()
    if not _SHA256_RE.fullmatch(rendered):
        raise InvalidAudioHashError("audio hash must be a 64-character hex SHA-256 digest")
    return rendered


@dataclass
class RemovalPlan:
    sha256: str
    catalog_csv: Path
    csv_paths: list[Path] = field(default_factory=list)
    csv_rows: dict[str, int] = field(default_factory=dict)
    source_files: list[Path] = field(default_factory=list)
    staged_files: list[Path] = field(default_factory=list)
    archived_files: list[Path] = field(default_factory=list)
    transcript_dirs: list[Path] = field(default_factory=list)
    diarization_dirs: list[Path] = field(default_factory=list)
    embedding_dirs: list[Path] = field(default_factory=list)

    @property
    def files(self) -> list[Path]:
        return [*self.source_files, *self.staged_files, *self.archived_files]

    @property
    def dirs(self) -> list[Path]:
        return [*self.transcript_dirs, *self.diarization_dirs, *self.embedding_dirs]

    @property
    def is_empty(self) -> bool:
        return not self.files and not self.dirs and not any(self.csv_rows.values())


@dataclass
class RemovalResult:
    files_removed: int = 0
    dirs_removed: int = 0
    csv_rows_removed: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def derived_csv_paths(catalog_csv: Path) -> list[Path]:
    stem = catalog_csv.stem
    return [catalog_csv.with_name(f"{stem}{suffix}.csv") for suffix in CATALOG_CSV_SUFFIXES]


def _rows_for_hash(csv_path: Path, sha256: str) -> list[dict[str, str]]:
    columns, rows = load_csv(csv_path, encoding="utf-8")
    try:
        hash_column = resolve_hash_column(columns, csv_path, preferred="Hash")
    except ValueError:
        return []
    return [row for row in rows if (row.get(hash_column, "") or "").strip().lower() == sha256]


def _existing_paths(rows: Iterable[dict[str, str]], column: str) -> list[Path]:
    paths: list[Path] = []
    for row in rows:
        raw = (row.get(column, "") or "").strip()
        if not raw:
            continue
        candidate = Path(raw).expanduser()
        if candidate.is_file() and candidate not in paths:
            paths.append(candidate)
    return paths


def find_embedding_dirs(
    sha256: str, *, transcripts_root: Path, extra_roots: Sequence[Path] = ()
) -> list[Path]:
    """Locate `speaker_embeddings/<model>/file/<hash>/` under every known root."""
    roots: list[Path] = []
    for root in [*_get_transcript_search_roots(transcripts_root), *extra_roots]:
        cache_root = (
            root if root.name == SPEAKER_EMBEDDINGS_DIRNAME else root / SPEAKER_EMBEDDINGS_DIRNAME
        )
        if cache_root.is_dir() and cache_root not in roots:
            roots.append(cache_root)
    found: list[Path] = []
    for cache_root in roots:
        for model_dir in cache_root.iterdir():
            hash_dir = model_dir / "file" / sha256
            if hash_dir.is_dir() and hash_dir not in found:
                found.append(hash_dir)
    return found


def build_removal_plan(
    sha256: str,
    *,
    catalog_csv: Path,
    transcripts_root: Path,
    embedding_roots: Sequence[Path] = (),
    delete_source: bool = False,
) -> RemovalPlan:
    sha256 = normalize_audio_hash(sha256)
    plan = RemovalPlan(sha256=sha256, catalog_csv=catalog_csv)

    for csv_path in derived_csv_paths(catalog_csv):
        if not csv_path.is_file():
            continue
        rows = _rows_for_hash(csv_path, sha256)
        plan.csv_paths.append(csv_path)
        plan.csv_rows[csv_path.name] = len(rows)
        if not rows:
            continue
        if csv_path == catalog_csv and delete_source:
            for source in _existing_paths(rows, "Full Path"):
                plan.source_files.append(source)
                sidecar = Path(f"{source}{AUDIO_HASH_SIDECAR_SUFFIX}")
                if sidecar.is_file():
                    plan.source_files.append(sidecar)
        elif csv_path.name.endswith("_loudness_normalized.csv"):
            plan.staged_files.extend(_existing_paths(rows, "Full Path"))
        elif csv_path.name.endswith("_loudness_archived.csv"):
            plan.archived_files.extend(_existing_paths(rows, "Compressed Path"))

    plan.transcript_dirs = find_transcript_dirs(transcripts_root, sha256)
    plan.diarization_dirs = find_diarization_dirs(transcripts_root, sha256)
    plan.embedding_dirs = find_embedding_dirs(
        sha256, transcripts_root=transcripts_root, extra_roots=embedding_roots
    )
    return plan


def remove_hash_from_csv(csv_path: Path, sha256: str) -> int:
    """Rewrite one catalog CSV without the hash's rows; atomic on success."""
    columns, rows = load_csv(csv_path, encoding="utf-8")
    try:
        hash_column = resolve_hash_column(columns, csv_path, preferred="Hash")
    except ValueError:
        return 0
    kept, removed = filter_catalog_rows(rows, remove_hashes={sha256}, hash_column=hash_column)
    kept = [row for row in kept if (row.get(hash_column, "") or "").strip().lower() != sha256]
    removed_count = len(rows) - len(kept)
    if removed_count == 0:
        return 0
    with atomic_path(csv_path) as temp_path:
        with temp_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=list(columns))
            writer.writeheader()
            for row in kept:
                writer.writerow({column: row.get(column, "") for column in columns})
    return removed_count


def execute_removal(plan: RemovalPlan) -> RemovalResult:
    """Delete artifacts first, then drop the CSV rows only when every deletion succeeded.

    Keeping the rows on a partial failure leaves the recording visible to
    `catalog check`/`clean` instead of silently orphaning the surviving files.
    """
    result = RemovalResult()

    for path in plan.files:
        try:
            path.unlink(missing_ok=True)
            result.files_removed += 1
        except OSError as exc:
            result.errors.append(f"Failed to remove file {path}: {exc}")

    for directory in plan.dirs:
        try:
            shutil.rmtree(directory)
            result.dirs_removed += 1
        except FileNotFoundError:
            result.dirs_removed += 1
        except OSError as exc:
            result.errors.append(f"Failed to remove directory {directory}: {exc}")

    if result.errors:
        return result

    for csv_path in plan.csv_paths:
        try:
            result.csv_rows_removed[csv_path.name] = remove_hash_from_csv(csv_path, plan.sha256)
        except OSError as exc:
            result.errors.append(f"Failed to rewrite {csv_path}: {exc}")

    return result
