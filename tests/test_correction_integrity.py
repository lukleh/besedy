"""The nightly integrity check finds every way a live workspace can drift (ADR 0012)."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

from besedy.lib import correction_segmentation as cs
from besedy.lib.correction_integrity import check_workspace, main

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
            {"schema_version": 1, "status": "active", "staged_audio": {"sha256": audio_sha}}
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
    assert check_workspace(row, root) == []


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        (lambda row, root: row.update(source_fingerprint="0" * 64), "fingerprint"),
        (lambda row, root: row["spans"].pop(), "stored spans"),
        (lambda row, root: row["spans"][0].__setitem__(4, 1), "stored spans"),
        (lambda row, root: row.update(source_chunk_count=5), "chunk count"),
        (lambda row, root: row["segmentation_params"].update(splitGapSamples=1), "parameters"),
        (lambda row, root: row.update(segmentation_version="chunks-v0"), "segmentation version"),
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
    problems = check_workspace(row, root)
    assert any(expected in problem for problem in problems), problems


def test_the_command_exits_non_zero_on_problems(workspace, monkeypatch, capsys) -> None:
    row, root = workspace
    broken = dict(row, id="66666666-7777-8888-9999-000000000000", bad_revision_hashes=1)
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps([row, broken])))
    assert main(["--corrections-root", str(root)]) == 1
    output = capsys.readouterr().out
    assert "2 workspaces checked, 1 with problems" in output

    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(json.dumps([row])))
    assert main(["--corrections-root", str(root), "--skip-audio-hash"]) == 0
