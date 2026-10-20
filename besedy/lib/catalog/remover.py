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

import re
import shutil
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from besedy.core.paths import extract_timestamp_from_catalog
from besedy.lib.catalog.cleaner import (
    _get_transcript_search_roots,
    find_diarization_dirs,
    find_transcript_dirs,
)
from besedy.lib.catalog.manager import load_csv, resolve_hash_column, write_merged_csv
from besedy.lib.data.atomic_io import rewrite_lock

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
# The joined manifest has one row per source part of a join. The recording the
# catalog lists is the joined output, so a removed hash matches `Output Hash`.
# The parts left the catalog when they were joined; a part's hash going away
# (for example `clean` dropping a moved original) keeps the join's provenance.
JOINED_HASH_COLUMN = "Output Hash"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_BASE_CATALOG_RE = re.compile(r"^audio_catalog_\d{8}_\d{6}\.csv$")


class InvalidAudioHashError(ValueError):
    """Raised when the hash is not a full lowercase SHA-256 hex digest."""


class CatalogTimestampError(ValueError):
    """Raised when a catalog path is not named audio_catalog_<YYYYMMDD_HHMMSS>.csv."""


@dataclass(frozen=True)
class CatalogGeneration:
    """The files one catalog's pipeline runs derive from its timestamp.

    Commands that change a catalog's artifacts use these paths, never the
    "latest" symlinks (`audio_catalog*.csv`, `audio_staged`,
    `transcripts/transcripts`), which may name another catalog.
    """

    catalog_csv: Path
    timestamp: str
    transcripts_parent: Path

    @property
    def transcripts_root(self) -> Path:
        return self.transcripts_parent / f"transcripts_{self.timestamp}"

    @property
    def embeddings_root(self) -> Path:
        return self.transcripts_parent / SPEAKER_EMBEDDINGS_DIRNAME

    @property
    def ingest_lock_path(self) -> Path:
        """The per-catalog lock admin uploads hold around their whole pipeline."""
        return self.catalog_csv.parent / f".ingest-{self.timestamp}.lock"

    @property
    def csv_paths(self) -> list[Path]:
        return derived_csv_paths(self.catalog_csv)

    def derived_csv(self, suffix: str) -> Path:
        return self.catalog_csv.with_name(f"{self.catalog_csv.stem}{suffix}.csv")


def catalog_generation(catalog_csv: Path, *, transcripts_parent: Path) -> CatalogGeneration:
    resolved = catalog_csv.resolve()
    timestamp = extract_timestamp_from_catalog(resolved)
    if timestamp is None:
        raise CatalogTimestampError(f"Could not extract a catalog timestamp from {resolved}")
    return CatalogGeneration(
        catalog_csv=resolved, timestamp=timestamp, transcripts_parent=transcripts_parent
    )


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
    shared_catalog_refs: list[Path] = field(default_factory=list)
    shared_source_files: list[Path] = field(default_factory=list)
    shared_derived_files: list[Path] = field(default_factory=list)

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


def find_other_catalog_references(catalog_csv: Path, sha256: str) -> list[Path]:
    """Return other base catalogs that still contain ``sha256``.

    Transcript generations are catalog-scoped, but the speaker embedding cache
    is shared by decoded-audio hash. Keep that cache while another catalog can
    still use the recording.
    """
    sha256 = normalize_audio_hash(sha256)
    return find_other_catalog_references_for(catalog_csv, [sha256])[sha256]


def find_other_catalog_references_for(
    catalog_csv: Path, hashes: Iterable[str]
) -> dict[str, list[Path]]:
    """`find_other_catalog_references` for many hashes, reading each catalog once."""
    wanted = {value.strip().lower() for value in hashes}
    references: dict[str, list[Path]] = {value: [] for value in wanted}
    current = catalog_csv.resolve()
    for candidate in sorted(catalog_csv.parent.glob("audio_catalog_*.csv")):
        if candidate.is_symlink() or not _BASE_CATALOG_RE.fullmatch(candidate.name):
            continue
        if candidate.resolve() == current:
            continue
        for value in wanted & _csv_hashes(candidate):
            references[value].append(candidate)
    return references


def _hash_column(csv_path: Path, columns: Sequence[str]) -> str | None:
    """The column a removed hash is matched against, or None when the CSV has none."""
    if csv_path.resolve().name.endswith("_joined.csv"):
        return JOINED_HASH_COLUMN if JOINED_HASH_COLUMN in columns else None
    try:
        return resolve_hash_column(columns, csv_path, preferred="Hash")
    except ValueError:
        return None


def _row_hash(row: dict[str, str], column: str) -> str:
    return (row.get(column, "") or "").strip().lower()


def _csv_hashes(csv_path: Path) -> set[str]:
    columns, rows = load_csv(csv_path, encoding="utf-8")
    hash_column = _hash_column(csv_path, columns)
    if hash_column is None:
        return set()
    return {_row_hash(row, hash_column) for row in rows}


def _rows_for_hash(csv_path: Path, sha256: str) -> list[dict[str, str]]:
    columns, rows = load_csv(csv_path, encoding="utf-8")
    hash_column = _hash_column(csv_path, columns)
    if hash_column is None:
        return []
    return [row for row in rows if _row_hash(row, hash_column) == sha256]


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


def _archived_paths(rows: Sequence[dict[str, str]]) -> list[Path]:
    paths = _existing_paths(rows, "Compressed Path")
    # The AAC-in-MP4 copy that `catalog archive` writes next to the WebM,
    # whether or not the manifest recorded it (an interrupted backfill).
    paths.extend(path for path in _existing_paths(rows, "Compressed AAC Path") if path not in paths)
    for webm in _existing_paths(rows, "Compressed Path"):
        sibling = webm.with_suffix(".m4a")
        if webm.suffix == ".webm" and sibling.is_file() and sibling not in paths:
            paths.append(sibling)
    return paths


def _shared_source_paths(catalogs: Sequence[Path], sha256: str) -> set[Path]:
    return {
        source.resolve()
        for catalog in catalogs
        for source in _existing_paths(_rows_for_hash(catalog, sha256), "Full Path")
    }


def shared_derived_paths(catalogs: Sequence[Path], sha256: str) -> set[Path]:
    """Staged and archived files of ``sha256`` that other catalogs' manifests list.

    Staging and archive directories are per catalog generation, but an older
    `stage-audio` reused whatever `audio_staged` pointed at, so two catalogs
    can list the same staged WAV. Such a file stays while another catalog uses it.
    """
    shared: set[Path] = set()
    for catalog in catalogs:
        stem = catalog.stem
        staged_csv = catalog.with_name(f"{stem}_loudness_normalized.csv")
        if staged_csv.is_file():
            staged = _existing_paths(_rows_for_hash(staged_csv, sha256), "Full Path")
            shared.update(path.resolve() for path in staged)
        archived_csv = catalog.with_name(f"{stem}_loudness_archived.csv")
        if archived_csv.is_file():
            archived = _archived_paths(_rows_for_hash(archived_csv, sha256))
            shared.update(path.resolve() for path in archived)
    return shared


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
    shared_catalog_refs: Sequence[Path] = (),
) -> RemovalPlan:
    sha256 = normalize_audio_hash(sha256)
    plan = RemovalPlan(
        sha256=sha256,
        catalog_csv=catalog_csv,
        shared_catalog_refs=list(shared_catalog_refs),
    )
    shared_sources = _shared_source_paths(plan.shared_catalog_refs, sha256)
    shared_derived = shared_derived_paths(plan.shared_catalog_refs, sha256)

    def add_derived(target: list[Path], paths: Iterable[Path]) -> None:
        for path in paths:
            if path.resolve() in shared_derived:
                plan.shared_derived_files.append(path)
            else:
                target.append(path)

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
                if source.resolve() in shared_sources:
                    plan.shared_source_files.append(source)
                    continue
                plan.source_files.append(source)
                sidecar = Path(f"{source}{AUDIO_HASH_SIDECAR_SUFFIX}")
                if sidecar.is_file():
                    plan.source_files.append(sidecar)
        elif csv_path.name.endswith("_loudness_normalized.csv"):
            add_derived(plan.staged_files, _existing_paths(rows, "Full Path"))
        elif csv_path.name.endswith("_loudness_archived.csv"):
            add_derived(plan.archived_files, _archived_paths(rows))

    plan.transcript_dirs = find_transcript_dirs(transcripts_root, sha256)
    plan.diarization_dirs = find_diarization_dirs(transcripts_root, sha256)
    if not plan.shared_catalog_refs:
        plan.embedding_dirs = find_embedding_dirs(
            sha256, transcripts_root=transcripts_root, extra_roots=embedding_roots
        )
    return plan


def remove_hash_from_csv(csv_path: Path, sha256: str) -> int:
    """Rewrite one catalog CSV without the hash's rows; atomic on success."""
    return remove_hashes_from_csv(csv_path, {sha256})


def remove_hashes_from_csv(csv_path: Path, hashes: Collection[str]) -> int:
    """Rewrite one catalog CSV without the rows of ``hashes``; atomic on success.

    The file is read again here, so rows appended since the caller planned the
    removal are kept.
    """
    wanted = {value.strip().lower() for value in hashes}
    if csv_path.resolve().name.endswith("_loudness_archived.csv"):
        # `catalog archive --backfill-aac` rewrites this manifest outside the
        # ingest lock; share its lock so neither drops the other's change.
        with rewrite_lock(csv_path):
            return _remove_hashes_from_csv(csv_path, wanted)
    return _remove_hashes_from_csv(csv_path, wanted)


def _remove_hashes_from_csv(csv_path: Path, hashes: set[str]) -> int:
    columns, rows = load_csv(csv_path, encoding="utf-8")
    hash_column = _hash_column(csv_path, columns)
    if hash_column is None:
        return 0
    kept = [row for row in rows if _row_hash(row, hash_column) not in hashes]
    removed_count = len(rows) - len(kept)
    if removed_count == 0:
        return 0
    write_merged_csv(csv_path, kept, columns=columns, encoding="utf-8")
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
