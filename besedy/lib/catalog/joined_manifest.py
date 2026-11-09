"""Helpers for working with joined catalog CSV manifests."""

from __future__ import annotations

import csv
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths_common import SHA256_HASH_PATTERN

JOINED_CSV_COLUMNS = [
    "Source Order",
    "Source Hash",
    "Source Filename",
    "Source Path",
    "Source Duration",
    "Source Duration (s)",
    "Source Format",
    "Source Sample Rate",
    "Source Channels",
    "Source Bitrate (kbps)",
    "Source Title",
    "Source Artist",
    "Source Album",
    "Source Date",
    "Output Hash",
    "Output Filename",
    "Output Path",
    "Output Duration",
    "Output Duration (s)",
    "Output Format",
    "Output Sample Rate",
    "Output Channels",
    "Output Bitrate (kbps)",
    "Output Title",
    "Output Artist",
    "Output Album",
    "Output Comment",
    "Source Count",
    "Strategy",
    "Fades",
    "added_at",
]


def validate_joined_row(row: Mapping[str, object], label: str) -> None:
    """Require the current row shape and its explicit identities and ordering."""
    if set(row) != set(JOINED_CSV_COLUMNS) or any(value is None for value in row.values()):
        raise ValueError(f"{label} must contain exactly the current joined manifest columns")
    for column in ("Source Hash", "Output Hash"):
        if not SHA256_HASH_PATTERN.fullmatch(str(row[column])):
            raise ValueError(f"{label}: {column} must be a full lowercase audio hash")
    for column in ("Source Order", "Source Count"):
        if not re.fullmatch(r"[1-9][0-9]*", str(row[column])):
            raise ValueError(f"{label}: {column} must be a positive integer")
    if int(str(row["Source Order"])) > int(str(row["Source Count"])):
        raise ValueError(f"{label}: Source Order exceeds Source Count")


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
        columns = reader.fieldnames
        if columns is None or list(columns) != JOINED_CSV_COLUMNS:
            raise ValueError(f"{path} must use the current joined manifest header")
        rows = []
        for row in reader:
            validate_joined_row(row, f"{path}:{reader.line_num}")
            rows.append(row)
    return list(columns), rows


def build_join_signature(source_hashes: Iterable[str]) -> tuple[str, ...]:
    return tuple(value.strip() for value in source_hashes)


def group_joined_rows(rows: Iterable[dict[str, str]]) -> list[JoinedGroup]:
    grouped: dict[str, list[dict[str, str]]] = {}
    for idx, row in enumerate(rows):
        validate_joined_row(row, f"Joined row {idx + 1}")
        grouped.setdefault(row["Output Hash"], []).append(row)

    groups: list[JoinedGroup] = []
    for group_rows in grouped.values():
        sorted_rows = sorted(group_rows, key=lambda row: int(row["Source Order"]))
        source_hashes = tuple(row["Source Hash"] for row in sorted_rows)
        source_paths = tuple(row["Source Path"].strip() for row in sorted_rows)

        output_hash = sorted_rows[0]["Output Hash"]
        output_path = sorted_rows[0]["Output Path"].strip()
        output_filename = sorted_rows[0]["Output Filename"].strip()

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
