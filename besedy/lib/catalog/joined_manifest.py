"""Helpers for working with joined catalog CSV manifests."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class JoinedGroup:
    output_hash: str
    output_path: str
    output_filename: str
    source_hashes: tuple[str, ...]
    source_paths: tuple[str, ...]


def load_joined_manifest(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"{path} is missing a header row")
        rows = list(reader)
    return list(reader.fieldnames), rows


def build_join_signature(source_hashes: Iterable[str]) -> tuple[str, ...]:
    return tuple(value.strip() for value in source_hashes)


def _normalize(value: str | None) -> str:
    return (value or "").strip()


def _parse_source_order(value: str | None, fallback: int) -> int:
    try:
        return int((value or "").strip())
    except (TypeError, ValueError):
        return fallback


def group_joined_rows(rows: Iterable[dict[str, str]]) -> list[JoinedGroup]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for idx, row in enumerate(rows):
        output_key = (
            _normalize(row.get("Output Hash"))
            or _normalize(row.get("Output Path"))
            or _normalize(row.get("Output Filename"))
            or f"row-{idx}"
        )
        grouped.setdefault(output_key, []).append(row)

    groups: list[JoinedGroup] = []
    for group_rows in grouped.values():
        ordered = sorted(
            enumerate(group_rows),
            key=lambda item: _parse_source_order(item[1].get("Source Order"), item[0]),
        )
        sorted_rows = [row for _, row in ordered]
        source_hashes = tuple(_normalize(row.get("Source Hash")) for row in sorted_rows)
        source_paths = tuple(_normalize(row.get("Source Path")) for row in sorted_rows)

        output_hash = _normalize(sorted_rows[0].get("Output Hash"))
        output_path = _normalize(sorted_rows[0].get("Output Path"))
        output_filename = _normalize(sorted_rows[0].get("Output Filename"))

        groups.append(
            JoinedGroup(
                output_hash=output_hash,
                output_path=output_path,
                output_filename=output_filename,
                source_hashes=source_hashes,
                source_paths=source_paths,
            )
        )
    return groups


def find_duplicate_join(
    groups: Iterable[JoinedGroup],
    source_hashes: Iterable[str],
) -> JoinedGroup | None:
    signature = build_join_signature(source_hashes)
    if not signature or any(not value for value in signature):
        return None

    for group in groups:
        if not group.source_hashes or any(not value for value in group.source_hashes):
            continue
        if group.source_hashes == signature:
            return group
    return None
