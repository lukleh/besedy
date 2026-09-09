from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

import pytest

from besedy.cli.catalog import build_parser
from besedy.lib.catalog import remover

KEEP = "a" * 64
GONE = "b" * 64
TS = "20260201_120000"


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def _read_hashes(path: Path) -> list[str]:
    with path.open(encoding="utf-8", newline="") as handle:
        return [row["Hash"] for row in csv.DictReader(handle)]


def _touch(path: Path, content: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


class Layout:
    """A two-recording catalog with every derived artifact the pipeline produces."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.catalogs = root / "text" / "catalogs"
        self.transcripts_parent = root / "text" / "transcripts"
        self.transcripts_root = self.transcripts_parent / f"transcripts_{TS}"
        self.audio = root / "audio"
        self.media = root / "media"
        self.catalog_csv = self.catalogs / f"audio_catalog_{TS}.csv"

        self.sources = {h: _touch(self.media / f"{h[:6]}.mp3") for h in (KEEP, GONE)}
        for h, source in self.sources.items():
            _touch(Path(f"{source}.audiohash"), f"{h}  {source.name}\n".encode())
        self.staged = {
            h: _touch(self.audio / f"audio_staged_{TS}" / f"{h}.wav") for h in (KEEP, GONE)
        }
        self.archived = {
            h: _touch(self.audio / f"audio_archived_{TS}" / f"{h}.webm") for h in (KEEP, GONE)
        }
        self.transcript_dirs = {
            h: [
                _touch(
                    self.transcripts_root
                    / "faster-whisper"
                    / "large-v3@silero"
                    / h
                    / "transcript.json"
                ).parent,
                _touch(
                    self.transcripts_root / "canary-nemo" / "canary@vad" / h / "transcript.json"
                ).parent,
            ]
            for h in (KEEP, GONE)
        }
        for h in (KEEP, GONE):
            _touch(
                self.transcripts_root / "faster-whisper" / "large-v3@silero" / h / "transcript.srt"
            )
        self.diarization_dirs = {
            h: _touch(
                self.transcripts_root / "speaker_diarization" / "pyannote_x" / h / "speakers.json"
            ).parent
            for h in (KEEP, GONE)
        }
        self.embedding_dirs = {
            h: _touch(
                self.transcripts_parent
                / "speaker_embeddings"
                / "pyannote-embedding"
                / "file"
                / h
                / "embeddings.json"
            ).parent
            for h in (KEEP, GONE)
        }

        base_cols = ["Hash", "Hash Algorithm", "Full Path", "Scan Root", "Filename"]
        _write_csv(
            self.catalog_csv,
            base_cols,
            [
                {
                    "Hash": h,
                    "Hash Algorithm": "pcm-s16le-16000hz-mono-sha256-v1",
                    "Full Path": str(self.sources[h]),
                    "Scan Root": str(self.media),
                    "Filename": self.sources[h].name,
                }
                for h in (KEEP, GONE)
            ],
        )
        _write_csv(
            self.catalog_csv.with_name(f"audio_catalog_{TS}_loudness.csv"),
            base_cols + ["Integrated Loudness"],
            [
                {"Hash": h, "Full Path": str(self.sources[h]), "Integrated Loudness": "-16"}
                for h in (KEEP, GONE)
            ],
        )
        _write_csv(
            self.catalog_csv.with_name(f"audio_catalog_{TS}_loudness_normalized.csv"),
            base_cols,
            [{"Hash": h, "Full Path": str(self.staged[h])} for h in (KEEP, GONE)],
        )
        _write_csv(
            self.catalog_csv.with_name(f"audio_catalog_{TS}_loudness_archived.csv"),
            ["Hash", "Full Path", "Compressed Path"],
            [
                {
                    "Hash": h,
                    "Full Path": str(self.sources[h]),
                    "Compressed Path": str(self.archived[h]),
                }
                for h in (KEEP, GONE)
            ],
        )
        _write_csv(
            self.catalog_csv.with_name(f"audio_catalog_{TS}_duplicates.csv"),
            ["Hash", "Original Path", "Duplicate Path"],
            [
                {
                    "Hash": GONE,
                    "Original Path": str(self.sources[GONE]),
                    "Duplicate Path": "/media/dup.mp3",
                }
            ],
        )


@pytest.fixture
def layout(tmp_path: Path) -> Layout:
    return Layout(tmp_path)


def _plan(layout: Layout, sha: str, *, delete_source: bool) -> remover.RemovalPlan:
    return remover.build_removal_plan(
        sha,
        catalog_csv=layout.catalog_csv,
        transcripts_root=layout.transcripts_root,
        embedding_roots=[layout.transcripts_parent / "speaker_embeddings"],
        delete_source=delete_source,
    )


def test_plan_collects_every_artifact_of_one_hash(layout: Layout) -> None:
    plan = _plan(layout, GONE, delete_source=True)

    assert plan.csv_rows == {
        f"audio_catalog_{TS}.csv": 1,
        f"audio_catalog_{TS}_loudness.csv": 1,
        f"audio_catalog_{TS}_loudness_normalized.csv": 1,
        f"audio_catalog_{TS}_loudness_archived.csv": 1,
        f"audio_catalog_{TS}_duplicates.csv": 1,
    }
    assert set(plan.source_files) == {
        layout.sources[GONE],
        Path(f"{layout.sources[GONE]}.audiohash"),
    }
    assert plan.staged_files == [layout.staged[GONE]]
    assert plan.archived_files == [layout.archived[GONE]]
    assert set(plan.transcript_dirs) == set(layout.transcript_dirs[GONE])
    assert plan.diarization_dirs == [layout.diarization_dirs[GONE]]
    assert plan.embedding_dirs == [layout.embedding_dirs[GONE]]
    assert not plan.is_empty


def test_plan_without_delete_source_keeps_the_original(layout: Layout) -> None:
    plan = _plan(layout, GONE, delete_source=False)
    assert plan.source_files == []
    assert plan.staged_files == [layout.staged[GONE]]


def test_execute_removes_only_the_requested_hash(layout: Layout) -> None:
    plan = _plan(layout, GONE, delete_source=True)
    result = remover.execute_removal(plan)

    assert result.ok, result.errors
    assert result.files_removed == 4  # source, sidecar, staged, archived
    assert result.dirs_removed == 4  # 2 transcript dirs, diarization, embeddings

    for path in plan.files:
        assert not path.exists()
    for directory in plan.dirs:
        assert not directory.exists()

    # The other recording is untouched everywhere.
    assert layout.sources[KEEP].exists()
    assert layout.staged[KEEP].exists()
    assert layout.archived[KEEP].exists()
    for directory in layout.transcript_dirs[KEEP]:
        assert directory.is_dir()
    assert layout.diarization_dirs[KEEP].is_dir()
    assert layout.embedding_dirs[KEEP].is_dir()

    for csv_path in plan.csv_paths:
        assert _read_hashes(csv_path) == ([KEEP] if "duplicates" not in csv_path.name else [])
    assert result.csv_rows_removed[f"audio_catalog_{TS}.csv"] == 1


def test_execute_keeps_csv_rows_when_an_artifact_cannot_be_deleted(
    layout: Layout, monkeypatch
) -> None:
    plan = _plan(layout, GONE, delete_source=False)

    def failing_rmtree(path, *args, **kwargs):  # type: ignore[no-untyped-def]
        if Path(path) == layout.diarization_dirs[GONE]:
            raise PermissionError("read-only")
        return shutil.rmtree.__wrapped__(path, *args, **kwargs)  # type: ignore[attr-defined]

    real_rmtree = shutil.rmtree
    failing_rmtree.__wrapped__ = real_rmtree  # type: ignore[attr-defined]
    monkeypatch.setattr(remover.shutil, "rmtree", failing_rmtree)

    result = remover.execute_removal(plan)

    assert not result.ok
    assert any("read-only" in error for error in result.errors)
    # Rows stay so the recording remains visible to check/clean and a retry.
    assert _read_hashes(layout.catalog_csv) == [KEEP, GONE]
    assert result.csv_rows_removed == {}


def test_csv_rewrite_is_atomic_and_preserves_columns(layout: Layout) -> None:
    removed = remover.remove_hash_from_csv(layout.catalog_csv, GONE)
    assert removed == 1
    with layout.catalog_csv.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        assert reader.fieldnames == ["Hash", "Hash Algorithm", "Full Path", "Scan Root", "Filename"]
        rows = list(reader)
    assert [row["Hash"] for row in rows] == [KEEP]
    assert not list(layout.catalogs.glob("*.tmp*"))
    assert remover.remove_hash_from_csv(layout.catalog_csv, GONE) == 0


def test_invalid_hash_is_rejected(layout: Layout) -> None:
    with pytest.raises(remover.InvalidAudioHashError):
        _plan(layout, "not-a-hash", delete_source=False)
    with pytest.raises(remover.InvalidAudioHashError):
        _plan(layout, "../" + "a" * 61, delete_source=False)


def test_unknown_hash_yields_empty_plan(layout: Layout) -> None:
    plan = _plan(layout, "c" * 64, delete_source=True)
    assert plan.is_empty
    assert remover.execute_removal(plan).ok


# --- CLI ----------------------------------------------------------------------


def _run_cli(monkeypatch, layout: Layout, capsys, *argv: str) -> tuple[int, dict]:  # type: ignore[no-untyped-def]
    from besedy.commands.catalog import remove as remove_module

    monkeypatch.setattr(remove_module, "resolve_transcripts_root", lambda: layout.transcripts_root)
    monkeypatch.setattr(
        remove_module, "resolve_transcripts_parent", lambda: layout.transcripts_parent
    )
    parser = build_parser()
    args = parser.parse_args(
        ["remove", "--csv", str(layout.catalog_csv), "--format", "json", *argv]
    )
    code = args.func(args)
    return code, json.loads(capsys.readouterr().out)


def test_cli_dry_run_changes_nothing(monkeypatch, layout: Layout, capsys) -> None:  # type: ignore[no-untyped-def]
    code, payload = _run_cli(monkeypatch, layout, capsys, "--hash", GONE)
    assert code == 0
    assert payload["status"] == "success"
    assert payload["result"]["status"] == "dry_run"
    assert payload["result"]["transcript_dirs"]
    assert layout.staged[GONE].exists()
    assert _read_hashes(layout.catalog_csv) == [KEEP, GONE]


def test_cli_execute_removes_and_is_idempotent(monkeypatch, layout: Layout, capsys) -> None:  # type: ignore[no-untyped-def]
    code, payload = _run_cli(
        monkeypatch, layout, capsys, "--hash", GONE.upper(), "--execute", "--delete-source"
    )
    assert code == 0
    assert payload["result"]["status"] == "removed"
    assert payload["result"]["files_removed"] == 4
    assert not layout.sources[GONE].exists()
    assert _read_hashes(layout.catalog_csv) == [KEEP]

    code, payload = _run_cli(monkeypatch, layout, capsys, "--hash", GONE, "--execute")
    assert code == 0
    assert payload["result"]["status"] == "not_found"


def test_cli_rejects_bad_hash(monkeypatch, layout: Layout, capsys) -> None:  # type: ignore[no-untyped-def]
    code, payload = _run_cli(monkeypatch, layout, capsys, "--hash", "abc")
    assert code == 1
    assert payload["result"]["error"] == "invalid_hash"
