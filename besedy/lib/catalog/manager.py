"Core logic for audio catalog management (hashing, storage, merging)."

from __future__ import annotations

import csv
import hashlib
import logging
import os
import re
import subprocess
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from besedy.lib.audio.quality import AUDIO_QUALITY_COLUMNS
from besedy.lib.audio.types import format_size
from besedy.lib.data.atomic_io import atomic_write_text
from besedy.lib.subprocess_utils import check_binary

# Constants
SKIP_DIRECTORIES = {"@eaDir", "whisper.cpp", "whisperx"}
METADATA_TAG_COLUMNS = (
    "album",
    "artist",
    "comment",
    "date",
    "encoded_by",
    "encoder",
    "genre",
    "title",
    "track",
)
# Hash column name for content hash (decoded audio hash)
DEFAULT_HASH_COLUMN = "Hash"
# Persisted identity contract for values in the canonical ``Hash`` column.
AUDIO_HASH_ALGORITHM = "pcm-s16le-16000hz-mono-sha256-v1"
HASH_ALGORITHM_COLUMN = "Hash Algorithm"
AUDIO_HASH_ALGORITHM_MARKER = "# besedy-audio-hash-algorithm:"
SOURCE_FILE_SHA256_MARKER = "# besedy-source-file-sha256:"
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
# Column name preferences when reading existing catalogs
HASH_COLUMN_PREFERENCES = (DEFAULT_HASH_COLUMN,)
LOSSLESS_DURATION_EXTENSIONS = {
    "wav",
    "aiff",
    "aif",
    "aifc",
    "flac",
    "alac",
    "ape",
    "wv",
    "tta",
    "tak",
    "w64",
    "caf",
    "mka",
}
DURATION_MISMATCH_TOLERANCE_SECONDS = 1.0


def get_iso8601_timestamp() -> str:
    """Return current UTC time in ISO 8601 format with Z suffix.

    Returns:
        String like '2025-12-31T14:30:00Z'
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def file_mtime_to_iso8601(path: Path) -> str:
    """Convert file modification time to ISO 8601 format.

    Used when backfilling timestamps for existing files.

    Args:
        path: Path to file

    Returns:
        ISO 8601 timestamp string, or empty string if file doesn't exist.
    """
    try:
        mtime = path.stat().st_mtime
        return datetime.fromtimestamp(mtime, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except OSError:
        return ""


@dataclass
class FileRecord:
    hash: str
    filename: str
    full_path: Path
    hash_file: Path
    exists: bool
    size_bytes: int
    size_human: str
    status: str
    extension: str
    scan_root: str = ""
    duration: str = ""
    duration_seconds: float = 0.0
    date: str = ""
    codec: str = ""
    album: str = ""
    artist: str = ""
    comment: str = ""
    encoded_by: str = ""
    encoder: str = ""
    genre: str = ""
    title: str = ""
    track: str = ""
    sample_rate: str = ""
    bit_depth: str = ""
    channels: str = ""
    bitrate_kbps: str = ""
    integrated_loudness_lufs: str = ""
    true_peak_db: str = ""
    loudness_range_lu: str = ""
    input_thresh: str = ""
    target_offset: str = ""
    mean_volume_db: str = ""
    max_volume_db: str = ""
    needs_normalization: str = ""
    codec_profile: str = ""
    audio_content_hash: str = ""
    added_at: str = ""  # ISO 8601 timestamp when record was added
    hash_algorithm: str = AUDIO_HASH_ALGORITHM


def is_hidden(name: str) -> bool:
    return name.startswith(".")


def source_file_sha256(path: Path, chunk_size: int = 1_048_576) -> str:
    """Return SHA-256 over source-file bytes for sidecar cache validation.

    This checksum is integrity metadata, not a recording identity, and must
    never be stored in a catalog's canonical ``Hash`` column.
    """
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def read_fresh_audio_hash_sidecar(
    path: Path,
    *,
    source_path: Path,
    source_mtime: float,
) -> str | None:
    """Read a fresh sidecar for the canonical decoded-audio identity.

    A sidecar is reusable only when it names both the required identity
    algorithm and the SHA-256 of the exact source-file bytes it describes.
    The content checksum closes the timestamp-preserving replacement hole left
    by mtime-only cache validation. Older sidecars without these markers are
    recomputed and upgraded on the next successful scan.
    """
    try:
        if path.stat().st_mtime < source_mtime:
            return None
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    if not lines:
        return None
    stored_hash = lines[0].strip().split(None, 1)[0]
    if not _SHA256_RE.fullmatch(stored_hash):
        return None

    marker = f"{AUDIO_HASH_ALGORITHM_MARKER} {AUDIO_HASH_ALGORITHM}"
    if marker not in (line.strip() for line in lines[1:]):
        return None

    source_marker_prefix = f"{SOURCE_FILE_SHA256_MARKER} "
    source_hashes = [
        line.strip()[len(source_marker_prefix) :]
        for line in lines[1:]
        if line.strip().startswith(source_marker_prefix)
    ]
    if len(source_hashes) != 1 or not _SHA256_RE.fullmatch(source_hashes[0]):
        return None
    if source_file_sha256(source_path) != source_hashes[0].lower():
        return None
    return stored_hash.lower()


def write_audio_hash_sidecar(
    path: Path,
    *,
    hash_value: str,
    filename: str,
    source_file_sha256: str,
) -> None:
    """Write a canonical audio-identity sidecar with source integrity metadata."""
    content = f"{hash_value}  {filename}\n"
    content += f"{AUDIO_HASH_ALGORITHM_MARKER} {AUDIO_HASH_ALGORITHM}\n"
    content += f"{SOURCE_FILE_SHA256_MARKER} {source_file_sha256}\n"
    atomic_write_text(path, content)


def audio_content_sha256sum(
    path: Path,
    *,
    ffmpeg_binary: str = "ffmpeg",
    timeout: int | None = None,
    chunk_size: int = 1_048_576,
) -> str | None:
    """Compute SHA-256 hash of decoded PCM audio (16kHz mono s16le).

    This produces identical hashes for files with the same audio content
    but different metadata (e.g., ID3 tags). The audio is decoded and
    resampled to 16kHz mono to match Besedy's staging format.

    Args:
        path: Path to audio file.
        ffmpeg_binary: Path to ffmpeg executable.
        timeout: Optional timeout in seconds for the ffmpeg process.
        chunk_size: Size of chunks to read from ffmpeg output (default 1MB).

    Returns:
        64-character lowercase hex string, or None if decoding fails.
    """
    cmd = [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-vn",  # No video
        "-ar",
        "16000",  # 16kHz sample rate
        "-ac",
        "1",  # Mono
        "-f",
        "s16le",  # Raw PCM format
        "-acodec",
        "pcm_s16le",
        "pipe:1",
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        assert proc.stdout is not None
        digest = hashlib.sha256()
        while True:
            chunk = proc.stdout.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
        proc.wait(timeout=timeout or 120)
        if proc.returncode != 0:
            return None
        return digest.hexdigest()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        if "proc" in locals():
            proc.kill()
            proc.wait()
        return None


def resolve_full_path(dirpath: Path, name: str) -> tuple[Path, str, bool]:
    candidates: list[str] = []

    def add_candidate(value: str) -> None:
        if value not in candidates:
            candidates.append(value)

    add_candidate(unicodedata.normalize("NFC", name))
    add_candidate(name)
    add_candidate(unicodedata.normalize("NFD", name))

    for candidate in candidates:
        candidate_path = dirpath / candidate
        if candidate_path.is_file():
            resolved_name = unicodedata.normalize("NFC", candidate_path.name)
            return candidate_path, resolved_name, True

    fallback_name = unicodedata.normalize("NFC", name)
    return dirpath / fallback_name, fallback_name, False


def check_ffprobe(binary: str) -> bool:
    """Check if ffprobe binary is available."""
    return check_binary(binary, "-version")


def check_ffmpeg(binary: str) -> bool:
    """Check if ffmpeg binary is available."""
    return check_binary(binary, "-version")


def get_supported_audio_extensions(ffmpeg_binary: str = "ffmpeg") -> set[str]:
    """Query ffmpeg for supported demuxers and extract audio file extensions."""
    try:
        result = subprocess.run(
            [ffmpeg_binary, "-demuxers"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"ffmpeg binary '{ffmpeg_binary}' not found; install ffmpeg or pass an explicit path."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"Timed out while querying '{ffmpeg_binary} -demuxers'; ensure ffmpeg is functional."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"ffmpeg exited with {exc.returncode} when listing demuxers via '{ffmpeg_binary} -demuxers'."
        ) from exc

    extensions: set[str] = set()
    # Known audio-related demuxers and their common extensions
    audio_demuxers = {
        "mp3": ["mp3"],
        "wav": ["wav"],
        "flac": ["flac"],
        "ogg": ["ogg", "oga", "opus", "spx"],
        "matroska": ["mka", "mkv", "webm"],
        "mov": ["mp4", "m4a", "m4b", "m4p", "3gp", "3g2", "mj2"],
        "aac": ["aac"],
        "ac3": ["ac3"],
        "aiff": ["aiff", "aif", "aifc"],
        "ape": ["ape"],
        "asf": ["wma", "asf"],
        "au": ["au", "snd"],
        "avi": ["avi"],
        "caf": ["caf"],
        "dts": ["dts"],
        "eac3": ["eac3"],
        "amr": ["amr"],
        "tta": ["tta"],
        "voc": ["voc"],
        "w64": ["w64"],
        "wv": ["wv"],
        "xa": ["xa"],
    }

    lines = result.stdout.split("\n")
    in_demuxers = False
    for line in lines:
        if line.strip().startswith("--"):
            in_demuxers = True
            continue
        if not in_demuxers:
            continue
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[0] in ("D", "D "):
            demuxer_name = parts[1] if len(parts) >= 2 else ""
            for pattern, exts in audio_demuxers.items():
                if pattern in demuxer_name or demuxer_name in pattern:
                    extensions.update(exts)

    if not extensions:
        raise RuntimeError(f"Unable to detect audio demuxers from '{ffmpeg_binary} -demuxers'.")
    return extensions


def is_audio_file(file_path: Path, supported_extensions: set[str]) -> bool:
    if not supported_extensions:
        return True
    ext = file_path.suffix.lower().lstrip(".")
    return ext in supported_extensions


def collect_input_files(
    paths: Sequence[Path],
    *,
    supported_extensions: set[str] | None = None,
) -> tuple[list[Path], list[str]]:
    files: list[Path] = []
    warnings: list[str] = []
    seen: set[Path] = set()

    for raw_path in paths:
        path = raw_path.expanduser()
        if not path.exists():
            warnings.append(f"Input not found: {path}")
            continue
        if path.is_file():
            if path.name.endswith(".audiohash"):
                continue
            if path.resolve() in seen:
                continue
            if supported_extensions and not is_audio_file(path, supported_extensions):
                continue
            files.append(path)
            seen.add(path.resolve())
            continue
        if path.is_dir():
            for dirpath, dirnames, filenames in os.walk(path):
                dir_root = Path(dirpath)
                dirnames[:] = [
                    d for d in dirnames if not is_hidden(d) and d not in SKIP_DIRECTORIES
                ]
                for filename in filenames:
                    if is_hidden(filename) or filename.endswith(".audiohash"):
                        continue
                    candidate = dir_root / filename
                    if not candidate.is_file():
                        continue
                    resolved = candidate.resolve()
                    if resolved in seen:
                        continue
                    if supported_extensions and not is_audio_file(candidate, supported_extensions):
                        continue
                    files.append(candidate)
                    seen.add(resolved)
            continue
        warnings.append(f"Unsupported path type (skipped): {path}")

    return files, warnings


def build_record_for_file(
    file_path: Path, scan_root: str = ""
) -> tuple[FileRecord | None, str | None, str | None]:
    """Build a FileRecord for an audio file, computing or loading its content hash.

    Attempts to load a typed hash from a fresh .audiohash sidecar, otherwise
    computes the canonical audio content hash (decoded 16kHz mono PCM).
    Decoding failures are rejected instead of receiving another identity.

    Returns:
        Tuple of (record, error, warning). On success, error is None.
    """
    try:
        file_stat = file_path.stat()
        size_bytes = file_stat.st_size
        file_mtime = file_stat.st_mtime
    except OSError as exc:
        return None, f"Failed to stat {file_path}: {exc}", None

    normalized_name = unicodedata.normalize("NFC", file_path.name)
    # Canonical decoded-audio identity sidecar.
    hash_file = Path(f"{file_path}.audiohash")
    sidecar_warning: str | None = None
    hash_value = read_fresh_audio_hash_sidecar(
        hash_file,
        source_path=file_path,
        source_mtime=file_mtime,
    )

    if hash_value is None:
        # Compute audio content hash (decoded PCM 16kHz mono)
        hash_value = audio_content_sha256sum(file_path)
        if hash_value is None:
            return (
                None,
                f"Unable to compute canonical audio hash for {file_path}: "
                "audio decoding failed; file was not added to the catalog",
                None,
            )
        # Write/update sidecar file
        try:
            write_audio_hash_sidecar(
                hash_file,
                hash_value=hash_value,
                filename=normalized_name,
                source_file_sha256=source_file_sha256(file_path),
            )
        except OSError as exc:
            sidecar_warning = f"Unable to write hash sidecar for {file_path}: {exc}"

    record = FileRecord(
        hash=hash_value,
        filename=normalized_name,
        full_path=file_path.resolve(),
        hash_file=hash_file,
        exists=True,
        size_bytes=size_bytes,
        size_human=format_size(size_bytes),
        status="EXISTS",
        extension=file_path.suffix.lower().lstrip("."),
        scan_root=scan_root,
        hash_algorithm=AUDIO_HASH_ALGORITHM,
    )
    return record, None, sidecar_warning


def catalog_fieldnames(include_quality: bool = False) -> list[str]:
    """Return the canonical list of column names for audio catalog CSV files.

    Args:
        include_quality: If True, append audio quality/loudness columns.

    Returns:
        List of field names in order: Hash (content hash), Filename, metadata fields,
        and optionally audio quality columns (sample_rate, loudness, etc.).
    """
    fieldnames = [
        "Hash",  # Audio content hash (decoded PCM 16kHz mono)
        HASH_ALGORITHM_COLUMN,
        "Filename",
        "Size (bytes)",
        "Size (human)",
        "Full Path",
        "Scan Root",
        "Status",
        "Duration",
        "added_at",  # ISO 8601 timestamp when record was added
        "album",
        "artist",
        "comment",
        "date",
        "encoded_by",
        "encoder",
        "genre",
        "title",
        "track",
    ]
    if include_quality:
        fieldnames.extend(AUDIO_QUALITY_COLUMNS)
    return fieldnames


def file_record_to_row(record: FileRecord, columns: Sequence[str]) -> dict[str, str]:
    base: dict[str, object] = {
        "Hash": record.hash,  # Content hash (audio_content_hash is now the primary)
        HASH_ALGORITHM_COLUMN: record.hash_algorithm,
        "Filename": record.filename,
        "Size (bytes)": record.size_bytes if record.exists else 0,
        "Size (human)": record.size_human,
        "Full Path": str(record.full_path),
        "Scan Root": record.scan_root,
        "Status": record.status,
        "Duration": record.duration,
        "added_at": record.added_at,
        "album": record.album,
        "artist": record.artist,
        "comment": record.comment,
        "date": record.date,
        "encoded_by": record.encoded_by,
        "encoder": record.encoder,
        "genre": record.genre,
        "title": record.title,
        "track": record.track,
        "sample_rate": record.sample_rate,
        "bit_depth": record.bit_depth,
        "channels": record.channels,
        "bitrate_kbps": record.bitrate_kbps,
        "integrated_loudness_lufs": record.integrated_loudness_lufs,
        "true_peak_db": record.true_peak_db,
        "loudness_range_lu": record.loudness_range_lu,
        "input_thresh": record.input_thresh,
        "target_offset": record.target_offset,
        "mean_volume_db": record.mean_volume_db,
        "max_volume_db": record.max_volume_db,
        "needs_normalization": record.needs_normalization,
        "codec_profile": record.codec_profile,
    }
    return {column: str(base.get(column, "")) for column in columns}


def write_catalog_csv(
    records: list[FileRecord],
    csv_path: Path,
    *,
    include_quality: bool = False,
) -> None:
    """Write audio catalog records to a CSV file.

    Creates parent directories if needed. Uses UTF-8 encoding and minimal
    quoting for CSV compatibility.

    Args:
        records: List of FileRecord objects to write.
        csv_path: Output path for the CSV file.
        include_quality: If True, include audio quality columns in the output schema.
    """
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = catalog_fieldnames(include_quality=include_quality)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, quoting=csv.QUOTE_MINIMAL)
        writer.writeheader()
        for record in records:
            writer.writerow(file_record_to_row(record, fieldnames))


def load_csv(path: Path, *, encoding: str) -> tuple[Sequence[str], list[dict[str, str]]]:
    """Load a CSV file and return its headers and rows.

    Args:
        path: Path to the CSV file (supports ~ expansion).
        encoding: Character encoding (e.g., "utf-8").

    Returns:
        Tuple of (fieldnames, rows) where fieldnames is the header list
        and rows is a list of dictionaries keyed by column name.

    Raises:
        ValueError: If the CSV file is missing a header row.
    """
    with path.expanduser().open("r", encoding=encoding, newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path} is missing a header row")
        rows: list[dict[str, str]] = list(reader)
    return reader.fieldnames, rows


def resolve_hash_column(
    columns: Sequence[str],
    path: Path,
    *,
    preferred: str | None,
) -> str:
    if preferred and preferred in columns:
        return preferred

    lookup = {column.casefold(): column for column in columns}
    if preferred:
        key = preferred.casefold()
        if key in lookup:
            return lookup[key]

    for candidate in HASH_COLUMN_PREFERENCES:
        key = candidate.casefold()
        if key in lookup:
            return lookup[key]

    candidates = ", ".join(HASH_COLUMN_PREFERENCES)
    if preferred:
        raise ValueError(
            f"{path} is missing required hash column. Tried '{preferred}' and aliases [{candidates}]"
        )
    raise ValueError(f"{path} is missing required hash column. Expected one of [{candidates}]")


def adapt_row(
    row: dict[str, str],
    columns: Sequence[str],
    *,
    source_hash_column: str,
    target_hash_column: str,
) -> dict[str, str]:
    adapted: dict[str, str] = {}
    for column in columns:
        if column == target_hash_column:
            adapted[column] = row.get(column, row.get(source_hash_column, ""))
        else:
            adapted[column] = row.get(column, "")
    return adapted


def collect_hashes(rows: Iterable[dict[str, str]], *, hash_column: str) -> set[str]:
    hashes: set[str] = set()
    for row in rows:
        value = (row.get(hash_column, "") or "").strip()
        if value:
            hashes.add(value)
    return hashes


def require_audio_hash_contract(
    columns: Sequence[str],
    rows: Iterable[dict[str, str]],
    *,
    path: Path,
    hash_column: str = DEFAULT_HASH_COLUMN,
) -> None:
    """Require the canonical decoded-audio identity contract.

    Every hashed row must explicitly name the canonical algorithm. Untyped
    catalogs are unsupported because a hexadecimal digest alone does not prove
    which identity contract produced it.
    """
    lookup = {column.casefold(): column for column in columns}
    algorithm_column = lookup.get(HASH_ALGORITHM_COLUMN.casefold())
    if algorithm_column is None:
        raise ValueError(
            f"{path} is missing required {HASH_ALGORITHM_COLUMN!r}; "
            f"expected {AUDIO_HASH_ALGORITHM!r}"
        )

    invalid: set[str] = set()
    missing = 0
    for row in rows:
        if not (row.get(hash_column, "") or "").strip():
            continue
        algorithm = (row.get(algorithm_column, "") or "").strip()
        if not algorithm:
            missing += 1
        elif algorithm != AUDIO_HASH_ALGORITHM:
            invalid.add(algorithm)

    if missing or invalid:
        details: list[str] = []
        if missing:
            details.append(f"{missing} hashed row(s) have no algorithm")
        if invalid:
            details.append(f"unsupported algorithm(s): {', '.join(sorted(invalid))}")
        raise ValueError(
            f"{path} has an invalid {HASH_ALGORITHM_COLUMN!r} contract "
            f"({'; '.join(details)}); expected {AUDIO_HASH_ALGORITHM!r}"
        )


def merge_catalogs(
    source_rows: Iterable[dict[str, str]],
    target_rows: list[dict[str, str]],
    *,
    columns: Sequence[str],
    source_hash_column: str,
    target_hash_column: str,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Merge source catalog rows into target catalog, deduplicating by hash.

    This function appends rows from a source catalog to an existing target catalog,
    skipping any rows whose hash already exists in the target. It handles column
    name differences between catalogs via adapt_row().

    Algorithm:
        1. Collect all known hashes from target_rows into a set
        2. Iterate source_rows, skip if hash missing or already in target
        3. Adapt row columns to match target schema
        4. Append new rows to merged result and track separately in appended_rows
        5. Return both the full merged list and just the newly appended rows

    Args:
        source_rows: Iterable of row dicts from source catalog.
        target_rows: List of row dicts from existing target catalog.
        columns: Sequence of column names for the output schema.
        source_hash_column: Column name containing hash in source rows.
        target_hash_column: Column name containing hash in target rows.

    Returns:
        Tuple of (merged_rows, appended_rows):
        - merged_rows: All target rows plus new unique rows from source
        - appended_rows: Only the new rows that were added (subset of merged_rows)

    Note:
        - Rows with missing hash values are silently skipped
        - The function does NOT modify target_rows in place; returns new lists
        - Column adaptation handles cases where source uses different column names
    """
    known_hashes = collect_hashes(target_rows, hash_column=target_hash_column)
    merged_rows = list(target_rows)
    appended_rows: list[dict[str, str]] = []
    new_rows = 0
    missing_hash = 0

    for row in source_rows:
        hash_value = (row.get(source_hash_column) or row.get(target_hash_column) or "").strip()
        if not hash_value:
            missing_hash += 1
            continue
        if hash_value in known_hashes:
            continue
        known_hashes.add(hash_value)
        adapted_row = adapt_row(
            row,
            columns,
            source_hash_column=source_hash_column,
            target_hash_column=target_hash_column,
        )
        merged_rows.append(adapted_row)
        appended_rows.append(adapted_row)
        new_rows += 1

    return merged_rows, appended_rows


def write_merged_csv(
    path: Path,
    rows: Iterable[dict[str, str]],
    *,
    columns: Sequence[str],
    encoding: str,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.expanduser().open("w", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns))
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})


def filter_catalog_rows(
    rows: list[dict[str, str]],
    *,
    remove_hashes: set[str],
    hash_column: str,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """Filter catalog rows, removing those with hashes in remove_hashes.

    Args:
        rows: List of row dictionaries from catalog CSV.
        remove_hashes: Set of hash values to remove.
        hash_column: Column name containing the hash.

    Returns:
        Tuple of (kept_rows, removed_rows).
    """
    kept: list[dict[str, str]] = []
    removed: list[dict[str, str]] = []

    for row in rows:
        hash_value = (row.get(hash_column, "") or "").strip()
        if hash_value in remove_hashes:
            removed.append(row)
        else:
            kept.append(row)

    return kept, removed


def extend_with_quality_columns(columns: Sequence[str]) -> list[str]:
    updated = list(columns)
    for column in AUDIO_QUALITY_COLUMNS:
        if column not in updated:
            updated.append(column)
    return updated


def ensure_quality_columns(
    *,
    path: Path,
    rows: list[dict[str, str]],
    columns: Sequence[str],
    encoding: str,
    rewrite: bool,
) -> list[str]:
    updated = extend_with_quality_columns(columns)
    missing = [column for column in AUDIO_QUALITY_COLUMNS if column not in columns]
    if missing and rewrite:
        logging.info(
            "Upgrading catalog schema at %s with columns: %s",
            path,
            ", ".join(missing),
        )
        write_merged_csv(path, rows, columns=updated, encoding=encoding)
    return updated


def append_csv(
    path: Path,
    rows: Iterable[dict[str, str]],
    *,
    columns: Sequence[str],
    encoding: str,
) -> None:
    with path.expanduser().open("a", encoding=encoding, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns))
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in columns})
