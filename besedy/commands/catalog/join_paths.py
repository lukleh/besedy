"""Path and backup helpers for join.py."""

from __future__ import annotations

import csv
import shutil
import unicodedata
from pathlib import Path
from typing import Protocol

from besedy.commands.catalog.default_paths import get_default_joined_symlink
from besedy.lib.catalog.joined_manifest import (
    find_duplicate_join,
    group_joined_rows,
    load_joined_manifest,
)


class AudioFileLike(Protocol):
    path: Path


def _normalize_path_nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def _normalize_path_nfd(value: str) -> str:
    return unicodedata.normalize("NFD", value)


def _find_existing_path(path: Path) -> Path | None:
    """Find an existing path, trying NFC and NFD normalization."""
    if path.exists():
        return path
    path_nfc = Path(_normalize_path_nfc(str(path)))
    if path_nfc.exists():
        return path_nfc
    path_nfd = Path(_normalize_path_nfd(str(path)))
    if path_nfd.exists():
        return path_nfd
    return None


def _load_scan_roots_from_catalog(catalog_path: Path) -> list[str]:
    scan_roots: list[str] = []
    if not catalog_path.exists():
        return scan_roots

    with catalog_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None or "Scan Root" not in reader.fieldnames:
            return scan_roots
        for row in reader:
            root = (row.get("Scan Root") or "").strip()
            if root:
                scan_roots.append(root)
    return sorted(set(scan_roots))


def _find_scan_root(file_path: str, scan_roots: list[str]) -> str | None:
    if not scan_roots:
        return None

    normalized_path = _normalize_path_nfc(file_path)
    candidates: list[str] = []
    for root in scan_roots:
        normalized_root = _normalize_path_nfc(root)
        if normalized_path == normalized_root or normalized_path.startswith(
            normalized_root.rstrip("/") + "/"
        ):
            candidates.append(root)
    if not candidates:
        return None
    return max(candidates, key=lambda root: len(root))


def _calculate_relative_path(file_path: str, scan_root: str) -> Path:
    normalized_path = _normalize_path_nfc(file_path)
    normalized_root = _normalize_path_nfc(scan_root)
    if normalized_path.startswith(normalized_root):
        rel = normalized_path[len(normalized_root) :].lstrip("/")
        return Path(rel)
    return Path(Path(file_path).name)


def _check_duplicate_join(source_hashes: list[str]) -> tuple[bool, str | None]:
    return _check_duplicate_join_in_catalog(source_hashes, None)


def _check_duplicate_join_in_catalog(
    source_hashes: list[str],
    joined_catalog: Path | None,
) -> tuple[bool, str | None]:
    if joined_catalog is not None:
        joined_path = joined_catalog.expanduser()
        if not joined_path.exists():
            return False, f"joined catalog not found: {joined_path}"
    else:
        joined_symlink = get_default_joined_symlink()
        if not (joined_symlink.exists() or joined_symlink.is_symlink()):
            return False, None

        joined_path = joined_symlink.resolve()
        if not joined_path.exists():
            return False, f"joined catalog symlink points to missing file: {joined_path}"

    try:
        _, rows = load_joined_manifest(joined_path)
    except Exception as exc:
        return False, f"failed to read joined catalog {joined_path}: {exc}"
    groups = group_joined_rows(rows)
    duplicate = find_duplicate_join(groups, source_hashes)
    if not duplicate:
        return False, None

    output_ref = (
        duplicate.output_path or duplicate.output_filename or duplicate.output_hash or "<unknown>"
    )
    message = (
        "These source files were already joined (matched by audio content hash). "
        f"Existing output: {output_ref} (catalog: {joined_path})."
    )
    return True, message


def _plan_original_moves(
    files: list[AudioFileLike],
    *,
    backup_root: Path,
    scan_roots: list[str],
) -> list[tuple[Path, Path]]:
    if not backup_root:
        raise RuntimeError("Backup root is not configured.")

    planned: list[tuple[Path, Path]] = []
    seen_destinations: dict[Path, Path] = {}
    for info in files:
        src = info.path
        if not src.exists():
            raise RuntimeError(f"Source file not found: {src}")
        scan_root = _find_scan_root(str(src), scan_roots)
        if scan_root:
            rel_path = _calculate_relative_path(str(src), scan_root)
        else:
            rel_path = Path(src.name)
        dest = backup_root / rel_path
        if dest in seen_destinations:
            other = seen_destinations[dest]
            raise RuntimeError(
                f"Multiple source files map to the same backup path: {dest} ({other} and {src})."
            )
        if dest.exists():
            raise RuntimeError(f"Backup target already exists: {dest}")
        planned.append((src, dest))
        seen_destinations[dest] = src
    return planned


def _move_originals(
    files: list[AudioFileLike],
    *,
    backup_root: Path,
    scan_roots: list[str],
) -> int:
    planned = _plan_original_moves(files, backup_root=backup_root, scan_roots=scan_roots)

    moved: list[tuple[Path, Path]] = []
    for src, dest in planned:
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(src), str(dest))
        except Exception as exc:
            rollback_errors: list[str] = []
            for rollback_src, rollback_dest in reversed(moved):
                try:
                    shutil.move(str(rollback_dest), str(rollback_src))
                except Exception as rollback_exc:
                    rollback_errors.append(f"{rollback_dest} -> {rollback_src}: {rollback_exc}")
            if rollback_errors:
                raise RuntimeError(
                    f"Failed to move {src} -> {dest}: {exc}. "
                    f"Rollback failures: {', '.join(rollback_errors)}"
                ) from exc
            raise RuntimeError(f"Failed to move {src} -> {dest}: {exc}") from exc
        moved.append((src, dest))
    return len(moved)


def _load_duplicate_paths(
    *,
    source_hashes: set[str],
    duplicates_csv: Path,
) -> list[Path]:
    paths: list[Path] = []
    if not duplicates_csv.exists():
        return paths
    with duplicates_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return paths
        if "Hash" not in reader.fieldnames or "Duplicate Path" not in reader.fieldnames:
            return paths
        for row in reader:
            file_hash = (row.get("Hash") or "").strip().lower()
            if not file_hash or file_hash not in source_hashes:
                continue
            dup_path = (row.get("Duplicate Path") or "").strip()
            if not dup_path:
                continue
            paths.append(Path(dup_path))
    return paths


def _load_catalog_paths_for_hashes(
    *,
    source_hashes: set[str],
    catalog_csv: Path,
) -> list[Path]:
    paths: list[Path] = []
    if not catalog_csv.exists():
        return paths
    with catalog_csv.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            return paths
        lower = [h.strip().lower() for h in header]
        if "hash" not in lower:
            return paths
        if "full path" in lower:
            path_idx = lower.index("full path")
        elif "path" in lower:
            path_idx = lower.index("path")
        else:
            return paths
        hash_idx = lower.index("hash")
        for row in reader:
            if hash_idx >= len(row) or path_idx >= len(row):
                continue
            file_hash = (row[hash_idx] or "").strip().lower()
            if file_hash not in source_hashes:
                continue
            raw_path = (row[path_idx] or "").strip()
            if not raw_path:
                continue
            paths.append(Path(raw_path))
    return paths


def _load_sidecar_paths_for_hashes(
    *,
    source_hashes: set[str],
    scan_roots: list[str],
) -> list[Path]:
    if not scan_roots:
        return []

    from besedy.commands.catalog.duplicates import find_hash_sidecar_files, parse_hash_sidecar_file

    paths: list[Path] = []
    for root in sorted(set(scan_roots)):
        root_path = Path(root)
        if not root_path.is_dir():
            continue
        for sidecar in find_hash_sidecar_files(root_path):
            parsed = parse_hash_sidecar_file(sidecar)
            if not parsed:
                continue
            hash_value, media_path = parsed
            if hash_value in source_hashes:
                paths.append(media_path)
    return paths


def _move_duplicate_paths(
    paths: list[Path],
    *,
    backup_root: Path,
    scan_roots: list[str],
    joined_root: Path | None,
    skip_paths: set[str],
) -> tuple[int, int, int, int, list[str]]:
    moved = 0
    skipped_missing = 0
    skipped_existing = 0
    skipped_joined = 0
    errors: list[str] = []

    duplicates_root = backup_root / "duplicates"

    for raw_src in paths:
        src = _find_existing_path(raw_src)
        if src is None:
            skipped_missing += 1
            continue
        if _normalize_path_nfc(str(src)) in skip_paths:
            continue
        if joined_root and joined_root in src.parents:
            skipped_joined += 1
            continue

        scan_root = _find_scan_root(str(src), scan_roots)
        if scan_root:
            rel_path = _calculate_relative_path(str(src), scan_root)
        else:
            rel_path = Path(src.name)

        dest = duplicates_root / rel_path
        if dest.exists():
            skipped_existing += 1
            continue

        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(src), str(dest))
        except Exception as exc:
            errors.append(f"{src} -> {dest}: {exc}")
            continue
        moved += 1

    return moved, skipped_missing, skipped_existing, skipped_joined, errors
