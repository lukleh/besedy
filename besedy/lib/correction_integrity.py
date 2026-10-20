"""Nightly integrity check of live correction workspaces (ADR 0012).

Correction work cannot be redone, so production checks every night that what
it depends on is still intact. ``web/scripts/correction-integrity-check.sh``
reads the workspaces from PostgreSQL and passes them here as JSON; this module
checks, for each live workspace under the data contract:

- the frozen source file still has the fingerprint recorded at start;
- cutting that source again gives exactly the stored spans, with the stored
  segmentation version and parameters;
- the staged audio still has the recorded size and SHA-256;
- the workspace manifest the Python guards read is present and agrees;
- every text revision still matches its hash (counted in SQL).

Usage: ``python -m besedy.lib.correction_integrity [--corrections-root DIR]
[--skip-audio-hash] < workspaces.json``. Exits 1 when anything is wrong.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from besedy.core.paths_runtime import resolve_corrections_root
from besedy.lib import correction_segmentation as cs
from besedy.lib.correction_guard import MANIFEST_NAME


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _mapped(path: str, path_map: Mapping[str, str]) -> Path:
    """Apply the longest matching prefix mapping, as the web does for host paths."""
    for source in sorted(path_map, key=len, reverse=True):
        if path == source or path.startswith(source.rstrip("/") + "/"):
            return Path(path_map[source] + path[len(source) :])
    return Path(path)


def check_workspace(
    workspace: Mapping[str, Any],
    corrections_root: Path,
    *,
    hash_audio: bool = True,
    path_map: Mapping[str, str] | None = None,
) -> list[str]:
    """Problems found in one workspace; empty when it is intact."""
    problems: list[str] = []
    workspace_dir = (
        corrections_root / f"corrections_{workspace['workflow_group_id']}" / str(workspace["id"])
    )

    source_path = workspace_dir / "source" / "transcript.json"
    try:
        source_bytes = source_path.read_bytes()
    except OSError as exc:
        return [f"frozen source unreadable: {exc}"]
    if hashlib.sha256(source_bytes).hexdigest() != workspace["source_fingerprint"]:
        problems.append("frozen source fingerprint changed")

    try:
        segmentation = cs.segment_transcript(json.loads(source_bytes.decode("utf-8")))
    except (ValueError, cs.SegmentationError) as exc:
        problems.append(f"frozen source cannot be segmented: {exc}")
    else:
        if segmentation.version != workspace["segmentation_version"]:
            problems.append(
                f"segmentation version {workspace['segmentation_version']} is not this code's "
                f"{segmentation.version}; check it with the version that cut it"
            )
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

    audio_path = _mapped(str(workspace["staged_audio_path"]), path_map or {})
    try:
        size = audio_path.stat().st_size
    except OSError as exc:
        problems.append(f"staged audio unreadable: {exc}")
    else:
        if size != int(workspace["staged_audio_size"]):
            problems.append("staged audio size changed")
        elif hash_audio and _sha256_file(audio_path) != workspace["staged_audio_sha256"]:
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
    return problems


def check_workspaces(
    workspaces: Iterable[Mapping[str, Any]],
    corrections_root: Path,
    *,
    hash_audio: bool = True,
    path_map: Mapping[str, str] | None = None,
) -> dict[str, list[str]]:
    return {
        str(workspace["id"]): check_workspace(
            workspace, corrections_root, hash_audio=hash_audio, path_map=path_map
        )
        for workspace in workspaces
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corrections-root", type=Path, default=None)
    parser.add_argument(
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
        workspaces, root, hash_audio=not args.skip_audio_hash, path_map=path_map
    )
    failed = {workspace: problems for workspace, problems in results.items() if problems}
    for workspace, problems in results.items():
        print(f"{'FAIL' if problems else 'OK  '} {workspace}")
        for problem in problems:
            print(f"     - {problem}")
    print(f"{len(results)} workspaces checked, {len(failed)} with problems")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
