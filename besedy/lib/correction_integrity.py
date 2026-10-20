"""Nightly integrity check of live correction workspaces (ADR 0012).

Correction work cannot be redone, so production checks every night that what
it depends on is still intact. ``web/scripts/correction-integrity-check.sh``
reads the workspaces from PostgreSQL and passes them here as JSON; this module
checks, for each live workspace under the data contract:

- the frozen source file still has the fingerprint recorded at start;
- cutting that source again gives exactly the stored spans, with the stored
  segmentation version and parameters;
- the staged audio still has the recorded size, and its SHA-256 on the nights
  its turn comes (``--audio-hash-every-days``; hashing every WAV every night
  reads hundreds of megabytes per workspace);
- the workspace manifest the Python guards read is present and agrees;
- every text revision still matches its hash (counted in SQL).

A workspace cut by another segmentation version is noted rather than failed:
this code cannot re-cut it, and the other checks still run.

Usage: ``python -m besedy.lib.correction_integrity [--corrections-root DIR]
[--audio-hash-every-days N | --skip-audio-hash] < workspaces.json``. Exits 1
when anything is wrong.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from besedy.core.paths_runtime import resolve_corrections_root
from besedy.lib import correction_segmentation as cs
from besedy.lib.catalog.manager import source_file_sha256
from besedy.lib.correction_guard import MANIFEST_NAME, map_recorded_path


@dataclass
class WorkspaceCheck:
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def audio_hash_due(workspace_id: str, every_days: int, today: date) -> bool:
    """Whether tonight is this workspace's turn to hash its staged audio.

    Each workspace gets a fixed night in every ``every_days``, so the whole
    set is hashed once per cycle and the nightly load stays even.
    """
    if every_days <= 1:
        return True
    turn = int(hashlib.sha256(workspace_id.encode("utf-8")).hexdigest(), 16) % every_days
    return today.toordinal() % every_days == turn


def check_workspace(
    workspace: Mapping[str, Any],
    corrections_root: Path,
    *,
    hash_audio: bool = True,
    path_map: Mapping[str, str] | None = None,
) -> WorkspaceCheck:
    """What one workspace check found; no problems when it is intact."""
    result = WorkspaceCheck()
    problems = result.problems
    workspace_dir = (
        corrections_root / f"corrections_{workspace['workflow_group_id']}" / str(workspace["id"])
    )

    source_path = workspace_dir / "source" / "transcript.json"
    try:
        source_bytes = source_path.read_bytes()
    except OSError as exc:
        problems.append(f"frozen source unreadable: {exc}")
        return result
    if hashlib.sha256(source_bytes).hexdigest() != workspace["source_fingerprint"]:
        problems.append("frozen source fingerprint changed")

    if workspace["segmentation_version"] != cs.SEGMENTATION_VERSION:
        result.notes.append(
            f"cut with segmentation {workspace['segmentation_version']}, this code cuts "
            f"{cs.SEGMENTATION_VERSION}; stored spans not re-checked"
        )
    else:
        try:
            segmentation = cs.segment_transcript(json.loads(source_bytes.decode("utf-8")))
        except (ValueError, cs.SegmentationError) as exc:
            problems.append(f"frozen source cannot be segmented: {exc}")
        else:
            if dict(workspace.get("segmentation_params") or {}) != segmentation.params:
                problems.append("segmentation parameters differ from the recorded ones")
            if segmentation.chunk_count != workspace["source_chunk_count"]:
                problems.append("chunk count differs from the recorded one")
            expected = [
                [s.chunk, s.first_region, s.last_region, s.start_sample, s.end_sample]
                for s in segmentation.spans
            ]
            stored = [list(span) for span in workspace.get("spans") or []]
            if stored != expected:
                problems.append(
                    f"stored spans differ from the segmentation of the frozen source "
                    f"({len(stored)} stored, {len(expected)} expected)"
                )

    audio_path = map_recorded_path(str(workspace["staged_audio_path"]), path_map or {})
    try:
        size = audio_path.stat().st_size
    except OSError as exc:
        problems.append(f"staged audio unreadable: {exc}")
    else:
        if size != int(workspace["staged_audio_size"]):
            problems.append("staged audio size changed")
        elif hash_audio and source_file_sha256(audio_path) != workspace["staged_audio_sha256"]:
            problems.append("staged audio content changed")

    try:
        manifest = json.loads((workspace_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        problems.append(f"workspace manifest unreadable: {exc}")
    else:
        if manifest.get("status") != "active":
            problems.append("workspace manifest does not say active")
        if (manifest.get("staged_audio") or {}).get("sha256") != workspace["staged_audio_sha256"]:
            problems.append("workspace manifest names other staged audio")

    if int(workspace.get("bad_revision_hashes") or 0):
        problems.append(f"{workspace['bad_revision_hashes']} revisions no longer match their hash")
    return result


def check_workspaces(
    workspaces: Iterable[Mapping[str, Any]],
    corrections_root: Path,
    *,
    audio_hash_every_days: int | None = 1,
    path_map: Mapping[str, str] | None = None,
    today: date | None = None,
) -> dict[str, WorkspaceCheck]:
    """Check every workspace; ``audio_hash_every_days=None`` never hashes audio."""
    today = today or date.today()
    return {
        str(workspace["id"]): check_workspace(
            workspace,
            corrections_root,
            hash_audio=audio_hash_every_days is not None
            and audio_hash_due(str(workspace["id"]), audio_hash_every_days, today),
            path_map=path_map,
        )
        for workspace in workspaces
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corrections-root", type=Path, default=None)
    hashing = parser.add_mutually_exclusive_group()
    hashing.add_argument(
        "--audio-hash-every-days",
        type=int,
        default=1,
        metavar="N",
        help="Hash each workspace's staged audio on one night in N (default: every night)",
    )
    hashing.add_argument(
        "--skip-audio-hash",
        action="store_true",
        help="Check staged audio size only, not its SHA-256",
    )
    parser.add_argument(
        "--map-path",
        action="append",
        default=[],
        metavar="FROM=TO",
        help="Read staged audio recorded under FROM from TO (for test environments)",
    )
    args = parser.parse_args(argv)
    path_map = dict(item.split("=", 1) for item in args.map_path)

    workspaces = json.load(sys.stdin) or []
    root = resolve_corrections_root(args.corrections_root)
    results = check_workspaces(
        workspaces,
        root,
        audio_hash_every_days=None if args.skip_audio_hash else args.audio_hash_every_days,
        path_map=path_map,
    )
    failed = {workspace: check for workspace, check in results.items() if check.problems}
    for workspace, check in results.items():
        print(f"{'FAIL' if check.problems else 'OK  '} {workspace}")
        for problem in check.problems:
            print(f"     - {problem}")
        for note in check.notes:
            print(f"     note: {note}")
    print(f"{len(results)} workspaces checked, {len(failed)} with problems")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
