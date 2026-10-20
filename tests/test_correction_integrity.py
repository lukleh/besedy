"""The nightly integrity check finds every way a live workspace can drift (ADR 0012)."""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from besedy.lib import correction_segmentation as cs
from besedy.lib.correction_integrity import (
    audio_hash_due,
    check_workspace,
    check_workspaces,
    find_orphan_manifests,
    main,
)

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[1] / "contracts" / "correction-segmentation.json").read_text(
        encoding="utf-8"
    )
)
TRANSCRIPT = next(c for c in CONTRACT["cases"] if c["name"] == "split_at_one_second_gap")[
    "transcript"
]
CATALOG = "20251222_144441"
WORKSPACE = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def workspace(tmp_path: Path) -> tuple[dict, Path]:
    root = tmp_path / "corrections"
    workspace_dir = root / f"corrections_{CATALOG}" / WORKSPACE
    (workspace_dir / "source").mkdir(parents=True)
    source = json.dumps(TRANSCRIPT, ensure_ascii=False, indent=2)
    (workspace_dir / "source" / "transcript.json").write_text(source, encoding="utf-8")

    audio = tmp_path / "audio_staged" / ("a" * 64 + ".wav")
    audio.parent.mkdir()
    audio.write_bytes(b"RIFF staged bytes")
    audio_sha = hashlib.sha256(audio.read_bytes()).hexdigest()

    (workspace_dir / "workspace.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "workflow_group_id": CATALOG,
                "audio_hash": "a" * 64,
                "workspace_id": WORKSPACE,
                "status": "active",
                "segmentation_version": cs.SEGMENTATION_VERSION,
                "staged_audio": {
                    "path": str(audio),
                    "size": audio.stat().st_size,
                    "sha256": audio_sha,
                },
                "updated_at": "2026-10-20T04:00:00.000Z",
            }
        ),
        encoding="utf-8",
    )
    segmentation = cs.segment_transcript(TRANSCRIPT)
    row = {
        "id": WORKSPACE,
        "workflow_group_id": CATALOG,
        "source_fingerprint": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "segmentation_version": segmentation.version,
        "segmentation_params": dict(segmentation.params),
        "source_chunk_count": segmentation.chunk_count,
        "staged_audio_path": str(audio),
        "staged_audio_size": audio.stat().st_size,
        "staged_audio_sha256": audio_sha,
        "spans": [
            [s.chunk, s.first_region, s.last_region, s.start_sample, s.end_sample]
            for s in segmentation.spans
        ],
        "bad_revision_hashes": 0,
    }
    return row, root


def test_an_intact_workspace_passes(workspace) -> None:
    row, root = workspace
    check = check_workspace(row, root)
    assert check.problems == []
    assert check.notes == []


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda row, root: row.update(source_fingerprint="0" * 64), "fingerprint"),
        (lambda row, root: row["spans"].pop(), "stored spans"),
        (lambda row, root: row["spans"][0].__setitem__(4, 1), "stored spans"),
        (lambda row, root: row.update(source_chunk_count=5), "chunk count"),
        (lambda row, root: row["segmentation_params"].update(splitGapSamples=1), "parameters"),
        (lambda row, root: row.update(bad_revision_hashes=2), "revisions"),
        (
            lambda row, root: Path(row["staged_audio_path"]).write_bytes(b"RIFF staged BYTES"),
            "content",
        ),
        (lambda row, root: Path(row["staged_audio_path"]).write_bytes(b"short"), "size"),
        (lambda row, root: Path(row["staged_audio_path"]).unlink(), "unreadable"),
        (
            lambda row, root: (
                root / f"corrections_{CATALOG}" / WORKSPACE / "workspace.json"
            ).unlink(),
            "manifest unreadable",
        ),
    ],
)
def test_each_kind_of_drift_is_reported(workspace, change, expected: str) -> None:
    row, root = workspace
    row = copy.deepcopy(row)
    change(row, root)
    problems = check_workspace(row, root).problems
    assert any(expected in problem for problem in problems), problems


def test_another_segmentation_version_is_noted_not_failed(workspace) -> None:
    row, root = workspace
    row = dict(copy.deepcopy(row), segmentation_version="chunks-v0", spans=[])
    check = check_workspace(row, root)
    assert check.problems == []
    assert any("chunks-v0" in note for note in check.notes)

    # The checks that do not depend on the version still run.
    Path(row["staged_audio_path"]).write_bytes(b"short")
    assert any("size" in problem for problem in check_workspace(row, root).problems)


def test_audio_hashing_rotates_through_the_workspaces(workspace) -> None:
    ids = [f"{index:08d}-0000-0000-0000-000000000000" for index in range(50)]
    start = date(2026, 10, 20)
    turns = [
        [day for day in range(7) if audio_hash_due(workspace_id, 7, start + timedelta(day))]
        for workspace_id in ids
    ]
    assert all(len(days) == 1 for days in turns)
    assert len({days[0] for days in turns}) > 1
    assert all(audio_hash_due(workspace_id, 1, start) for workspace_id in ids)

    row, root = workspace
    Path(row["staged_audio_path"]).write_bytes(b"RIFF staged BYTES")
    nights = [
        check_workspaces([row], root, audio_hash_every_days=7, today=start + timedelta(day))[
            WORKSPACE
        ].problems
        for day in range(7)
    ]
    assert sum(1 for problems in nights if problems) == 1
    assert check_workspaces([row], root, audio_hash_every_days=None)[WORKSPACE].problems == []


def test_the_command_exits_non_zero_on_problems(workspace, monkeypatch, capsys) -> None:
    row, root = workspace
    broken = dict(row, id="66666666-7777-8888-9999-000000000000", bad_revision_hashes=1)
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps([row, broken])))
    assert main(["--corrections-root", str(root)]) == 1
    output = capsys.readouterr().out
    assert "2 workspaces checked, 1 with problems, 0 orphan manifests" in output

    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps([row])))
    assert main(["--corrections-root", str(root), "--skip-audio-hash"]) == 0


def _manifest_copy(root: Path, workspace_id: str, **changes) -> Path:
    source = root / f"corrections_{CATALOG}" / WORKSPACE / "workspace.json"
    data = {**json.loads(source.read_text(encoding="utf-8")), "workspace_id": workspace_id}
    data.update(changes)
    target = root / f"corrections_{CATALOG}" / workspace_id / "workspace.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"schema_version": 1, **data}), encoding="utf-8")
    return target


def test_orphan_manifests_are_reported(workspace, monkeypatch, capsys) -> None:
    row, root = workspace
    now = datetime.now(timezone.utc)

    def stamp(age: timedelta) -> str:
        return (now - age).isoformat().replace("+00:00", "Z")

    old_start = _manifest_copy(
        root, "orphan-starting", status="starting", updated_at=stamp(timedelta(days=1))
    )
    _manifest_copy(root, "fresh-start", status="starting", updated_at=stamp(timedelta(minutes=10)))
    _manifest_copy(root, "archived", status="archived", updated_at=stamp(timedelta(days=20)))
    stale_active = _manifest_copy(root, "orphan-active", status="active")

    orphans = find_orphan_manifests(root, [WORKSPACE], now=now)
    assert set(orphans) == {str(old_start), str(stale_active)}

    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps([row])))
    assert main(["--corrections-root", str(root)]) == 1
    assert "1 workspaces checked, 0 with problems, 2 orphan manifests" in capsys.readouterr().out
