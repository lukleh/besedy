"""Catalog commands given `--csv` act on that catalog, never on the one the "latest" symlinks name.

Production keeps several catalogs side by side. Each fixture here builds two
generations, OLD and NEW, with every "latest" symlink (`audio_catalog*.csv`,
`audio_staged`, `transcripts/transcripts`) pointing at NEW, then runs a command
against OLD and checks that NEW's files are untouched.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from besedy.commands.catalog import pipeline
from besedy.commands.catalog import stage as stage_command
from besedy.commands.catalog.clean import handle_clean
from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.lib.catalog import remover

OLD = "20260101_120000"
NEW = "20260301_120000"
GONE = "a" * 64  # source missing; in both catalogs
KEEP = "b" * 64  # source present; in both catalogs
NEW_ONLY = "c" * 64  # only in NEW

SUFFIXES = ("", "_loudness", "_loudness_normalized", "_loudness_archived", "_duplicates")
LATEST_LINKS = {
    "": "audio_catalog.csv",
    "_loudness": "audio_catalog_loudness.csv",
    "_loudness_normalized": "audio_catalog_normalized.csv",
    "_loudness_archived": "audio_catalog_archived.csv",
    "_duplicates": "audio_catalog_duplicates.csv",
}


def _write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def _hashes(path: Path, column: str = "Hash") -> list[str]:
    with path.open(encoding="utf-8", newline="") as handle:
        return [row[column] for row in csv.DictReader(handle)]


def _touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    return path


class Generation:
    """One catalog generation: CSVs, staged WAVs and transcripts for its hashes."""

    def __init__(self, layout: "Layout", ts: str, hashes: list[str]) -> None:
        self.ts = ts
        self.catalog = layout.catalogs / f"audio_catalog_{ts}.csv"
        self.staging_dir = layout.audio / f"audio_staged_{ts}"
        self.transcripts = layout.transcripts_parent / f"transcripts_{ts}"
        self.staged = {h: _touch(self.staging_dir / f"{h}.wav") for h in hashes}
        self.transcript_dirs = {
            h: _touch(
                self.transcripts / "faster-whisper" / "large-v3@silero" / h / "transcript.json"
            ).parent
            for h in hashes
        }
        self.sidecars = {h: _touch(self.transcript_dirs[h] / "transcript.srt") for h in hashes}

        sources = {h: layout.source(h) for h in hashes}
        columns = ["Hash", "Full Path"]
        for suffix in SUFFIXES:
            path = self.csv(suffix)
            if suffix == "_loudness_normalized":
                rows = [{"Hash": h, "Full Path": str(self.staged[h])} for h in hashes]
            else:
                rows = [{"Hash": h, "Full Path": str(sources[h])} for h in hashes]
            _write_csv(path, columns, rows)

    def csv(self, suffix: str) -> Path:
        return self.catalog.with_name(f"audio_catalog_{self.ts}{suffix}.csv")


class Layout:
    def __init__(self, root: Path) -> None:
        self.text = root / "text"
        self.catalogs = self.text / "catalogs"
        self.transcripts_parent = self.text / "transcripts"
        self.audio = root / "audio"
        self.media = root / "media"
        self.media.mkdir(parents=True)
        _touch(self.media / f"{KEEP[:6]}.mp3")

        self.old = Generation(self, OLD, [GONE, KEEP])
        self.new = Generation(self, NEW, [GONE, KEEP, NEW_ONLY])

        for suffix, name in LATEST_LINKS.items():
            (self.catalogs / name).symlink_to(self.new.csv(suffix).name)
        (self.audio / "audio_staged").symlink_to(self.new.staging_dir.name)
        (self.transcripts_parent / "transcripts").symlink_to(self.new.transcripts.name)

    def source(self, sha: str) -> Path:
        # GONE's source never exists, the others' do.
        return self.media / f"{sha[:6]}.mp3"

    def snapshot_new(self) -> dict[str, bytes]:
        files = [p for p in self.catalogs.glob(f"audio_catalog_{NEW}*.csv")]
        files += [p for p in self.new.staging_dir.rglob("*") if p.is_file()]
        files += [p for p in self.new.transcripts.rglob("*") if p.is_file()]
        return {str(p): p.read_bytes() for p in sorted(files)}


@pytest.fixture
def layout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Layout:
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(tmp_path / "text"))
    monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(tmp_path / "audio"))
    return Layout(tmp_path)


def _clean_args(csv_path: Path | None, **overrides) -> argparse.Namespace:  # type: ignore[no-untyped-def]
    values = {
        "csv": csv_path,
        "csv_normalized": None,
        "execute": True,
        "force": True,
        "prune_orphans": False,
        "verbose": False,
        "format": "json",
    }
    values.update(overrides)
    return argparse.Namespace(**values)


# --- clean ----------------------------------------------------------------------


def test_clean_on_an_older_catalog_leaves_the_latest_catalog_alone(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    before = layout.snapshot_new()

    assert handle_clean(_clean_args(layout.old.catalog)) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["result"]["hashes_removed"] == 1

    assert layout.snapshot_new() == before
    for suffix in SUFFIXES:
        assert GONE not in _hashes(layout.old.csv(suffix)), suffix
    assert KEEP in _hashes(layout.old.catalog)
    assert not layout.old.transcript_dirs[GONE].exists()
    assert not layout.old.staged[GONE].exists()
    assert layout.old.transcript_dirs[KEEP].is_dir()
    assert layout.old.staged[KEEP].is_file()


def test_clean_dry_run_reports_the_older_catalogs_artifacts(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    assert handle_clean(_clean_args(layout.old.catalog, execute=False)) == 0
    result = json.loads(capsys.readouterr().out)["result"]

    assert result["missing_hashes"] == [GONE]
    assert result["normalized_entries"] == 2
    assert result["staged_to_remove"] == 1
    assert result["transcript_dirs_to_remove"] == 1


def test_clean_through_the_latest_symlink_cleans_the_catalog_it_names(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    before = layout.snapshot_new()

    assert handle_clean(_clean_args(layout.catalogs / "audio_catalog.csv")) == 0
    capsys.readouterr()

    assert before != layout.snapshot_new()
    for suffix in SUFFIXES:
        assert GONE not in _hashes(layout.new.csv(suffix)), suffix
        assert GONE in _hashes(layout.old.csv(suffix)), suffix
    # The symlinks still point at their generation files.
    for name in LATEST_LINKS.values():
        assert (layout.catalogs / name).is_symlink()


def test_clean_keeps_a_staged_file_another_catalog_still_lists(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    """A shared staging dir (an older stage-audio reused `audio_staged`) keeps the WAV."""
    shared = layout.new.staged[GONE]
    _write_csv(
        layout.old.csv("_loudness_normalized"),
        ["Hash", "Full Path"],
        [{"Hash": h, "Full Path": str(layout.new.staged[h])} for h in (GONE, KEEP)],
    )

    assert handle_clean(_clean_args(layout.old.catalog)) == 0
    capsys.readouterr()

    assert shared.is_file()
    assert GONE not in _hashes(layout.old.csv("_loudness_normalized"))


def test_clean_rejects_a_normalized_manifest_from_another_catalog(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    before = layout.snapshot_new()
    old_before = layout.old.catalog.read_bytes()

    args = _clean_args(
        layout.old.catalog, csv_normalized=layout.catalogs / "audio_catalog_normalized.csv"
    )
    assert handle_clean(args) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["result"]["error"] == "catalog_mismatch"
    assert layout.snapshot_new() == before
    assert layout.old.catalog.read_bytes() == old_before


def test_clean_execute_holds_the_catalog_ingest_lock(
    layout: Layout, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Uploads take `.ingest-<ts>.lock` around their whole pipeline; clean must wait for it."""
    import fcntl

    from besedy.commands.catalog import clean as clean_command

    lock_path = layout.catalogs / f".ingest-{OLD}.lock"
    held: list[bool] = []
    real_execute = clean_command.execute_cleanup

    def probing_execute(plan):  # type: ignore[no-untyped-def]
        with lock_path.open("a+") as handle:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                held.append(True)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                held.append(False)
        return real_execute(plan)

    monkeypatch.setattr(clean_command, "execute_cleanup", probing_execute)

    assert handle_clean(_clean_args(layout.old.catalog)) == 0
    capsys.readouterr()
    assert held == [True]


def test_clean_execute_plans_under_the_ingest_lock(
    layout: Layout, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A recording removed and uploaded again while clean waits is not cleaned from a stale plan.

    The web removes hash GONE and an upload brings the same audio back, both
    under the ingest lock that clean is waiting for. Clean must read the
    catalog only once it holds the lock, so it sees the new, present source.
    """
    from contextlib import contextmanager

    from besedy.commands.catalog import clean as clean_command

    reuploaded = _touch(layout.media / "reuploaded.mp3")
    real_lock = clean_command.exclusive_lock

    @contextmanager
    def lock_after_reupload(lock_path):  # type: ignore[no-untyped-def]
        # Runs while the upload holds the lock, just before clean is granted it.
        _write_csv(
            layout.old.catalog,
            ["Hash", "Full Path"],
            [
                {"Hash": h, "Full Path": str(reuploaded if h == GONE else layout.source(h))}
                for h in (GONE, KEEP)
            ],
        )
        with real_lock(lock_path):
            yield

    monkeypatch.setattr(clean_command, "exclusive_lock", lock_after_reupload)

    assert handle_clean(_clean_args(layout.old.catalog)) == 0
    result = json.loads(capsys.readouterr().out)["result"]

    assert result["status"] == "no_missing"
    assert layout.old.staged[GONE].is_file()
    assert layout.old.transcript_dirs[GONE].is_dir()
    for suffix in SUFFIXES:
        assert GONE in _hashes(layout.old.csv(suffix)), suffix


def test_clean_dry_run_takes_no_lock(
    layout: Layout, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from besedy.commands.catalog import clean as clean_command

    def no_lock(_lock_path):  # type: ignore[no-untyped-def]
        raise AssertionError("a dry run must not wait for uploads")

    monkeypatch.setattr(clean_command, "exclusive_lock", no_lock)

    args = _clean_args(layout.old.catalog, execute=False, prune_orphans=True)
    assert handle_clean(args) == 0
    capsys.readouterr()


def test_clean_rejects_a_missing_explicit_normalized_manifest(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    old_before = layout.old.catalog.read_bytes()

    typo = layout.catalogs / f"audio_catalog_{OLD}_loudnes_normalized.csv"
    assert handle_clean(_clean_args(layout.old.catalog, csv_normalized=typo)) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["result"]["error"] == "normalized_csv_missing"
    assert layout.old.catalog.read_bytes() == old_before
    assert layout.old.staged[GONE].is_file()


def test_clean_hint_quotes_the_catalog_and_keeps_the_flags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import shlex

    root = tmp_path / "with space"
    monkeypatch.setenv("BESEDY_TEXT_DATA_ROOT", str(root / "text"))
    monkeypatch.setenv("BESEDY_AUDIO_ARTIFACTS_ROOT", str(root / "audio"))
    layout = Layout(root)

    args = _clean_args(layout.old.catalog, execute=False, format="text", prune_orphans=True)
    assert handle_clean(args) == 0
    hints = [
        line.removeprefix("To execute: ")
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("To execute: ")
    ]

    assert hints
    for hint in hints:
        assert shlex.split(hint) == [
            "just",
            "catalog",
            "clean",
            "--csv",
            str(layout.old.catalog.resolve()),
            "--force",
            "--prune-orphans",
            "--execute",
        ]


def test_clean_rewrites_csvs_from_their_current_content(
    layout: Layout, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """A row appended after clean read the CSVs survives the rewrite."""
    from besedy.commands.catalog import clean as clean_command

    late = "d" * 64
    real_execute = clean_command.execute_cleanup

    def execute_then_append(plan):  # type: ignore[no-untyped-def]
        result = real_execute(plan)
        with layout.old.csv("_loudness").open("a", encoding="utf-8", newline="") as handle:
            csv.writer(handle).writerow([late, "/media/late.mp3"])
        return result

    monkeypatch.setattr(clean_command, "execute_cleanup", execute_then_append)

    assert handle_clean(_clean_args(layout.old.catalog)) == 0
    capsys.readouterr()
    assert _hashes(layout.old.csv("_loudness")) == [KEEP, late]


# --- clean --prune-orphans ------------------------------------------------------


def test_prune_orphans_on_an_older_catalog_keeps_the_latest_sidecars(
    layout: Layout, capsys: pytest.CaptureFixture[str]
) -> None:
    before = layout.snapshot_new()
    stale = _touch(
        layout.old.transcripts / "faster-whisper" / "large-v3@silero" / NEW_ONLY / "transcript.srt"
    )

    args = _clean_args(layout.old.catalog, prune_orphans=True)
    assert handle_clean(args) == 0
    result = json.loads(capsys.readouterr().out)["result"]["prune_orphans"]

    assert result["stale_files_removed"] == 1
    assert not stale.exists()
    assert layout.snapshot_new() == before


# --- stage-audio ----------------------------------------------------------------


def _capture_staging(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    staged_into: list[Path] = []

    def stage_audio_files(_rows, staging_dir, *, manifest_writer, **_kwargs):  # type: ignore[no-untyped-def]
        staged_into.append(staging_dir)
        manifest_writer.write_entry(
            SimpleNamespace(sha256=KEEP, staged=staging_dir / f"{KEEP}.wav"), size_bytes=1
        )
        return [], []

    monkeypatch.setattr(stage_command, "stage_audio_files", stage_audio_files)
    monkeypatch.setattr(
        stage_command, "load_audio_rows", lambda *_args, **_kwargs: [SimpleNamespace()]
    )
    return staged_into


def test_stage_audio_for_an_older_catalog_uses_its_own_staging_dir(
    layout: Layout, monkeypatch: pytest.MonkeyPatch
) -> None:
    staged_into = _capture_staging(monkeypatch)

    request = stage_command.StageAudioRequest(
        csv=layout.old.csv("_loudness"), skip_audio_analysis=True
    )
    assert stage_command.handle_stage_audio(request) == 0

    assert staged_into == [layout.old.staging_dir]
    # Without --no-symlink the run makes OLD the latest generation, consistently.
    assert (layout.audio / "audio_staged").resolve() == layout.old.staging_dir
    assert (layout.catalogs / "audio_catalog_normalized.csv").resolve() == layout.old.csv(
        "_loudness_normalized"
    )


def test_stage_audio_reuses_the_staging_dir_of_its_own_catalog(
    layout: Layout, monkeypatch: pytest.MonkeyPatch
) -> None:
    staged_into = _capture_staging(monkeypatch)

    request = stage_command.StageAudioRequest(
        csv=layout.new.csv("_loudness"), skip_audio_analysis=True
    )
    assert stage_command.handle_stage_audio(request) == 0
    assert staged_into == [layout.new.staging_dir]


def test_stage_audio_through_the_loudness_symlink_writes_the_generation_manifest(
    layout: Layout, monkeypatch: pytest.MonkeyPatch
) -> None:
    _capture_staging(monkeypatch)

    request = stage_command.StageAudioRequest(
        csv=layout.catalogs / "audio_catalog_loudness.csv", skip_audio_analysis=True
    )
    assert stage_command.handle_stage_audio(request) == 0

    assert not (layout.catalogs / "audio_catalog_loudness_normalized.csv").exists()
    assert _hashes(layout.new.csv("_loudness_normalized")) == [KEEP]


# --- explicit symlinked --csv ---------------------------------------------------


def test_resolve_catalog_csv_follows_an_explicit_symlink(layout: Layout) -> None:
    resolved = resolve_catalog_csv(layout.catalogs / "audio_catalog.csv", purpose="test")
    assert resolved == layout.new.catalog.resolve()


def test_run_pipeline_through_the_catalog_symlink_derives_generation_paths(
    layout: Layout, monkeypatch: pytest.MonkeyPatch
) -> None:
    loudness_link = layout.catalogs / "audio_catalog_loudness.csv"
    seen: dict[str, Path] = {}

    def loudness(request):  # type: ignore[no-untyped-def]
        seen["csv"] = request.csv
        seen["output"] = request.output
        return 0

    def stage(request):  # type: ignore[no-untyped-def]
        seen["stage_csv"] = request.csv
        return 0

    monkeypatch.setattr(pipeline, "resolve_pipeline_workflows", lambda: ([], []))
    monkeypatch.setattr(pipeline, "handle_loudness", loudness)
    monkeypatch.setattr(pipeline, "handle_stage_audio", stage)
    monkeypatch.setattr(pipeline, "handle_archive", lambda _request: 0)
    monkeypatch.setattr(pipeline, "print_step", lambda *_args, **_kwargs: None)

    args = argparse.Namespace(
        csv=layout.catalogs / "audio_catalog.csv",
        continue_on_error=False,
        skip_derived=True,
        no_symlink=False,
        skip_rag_colbert_index=True,
        rag_backend=None,
        rag_all_backends=False,
    )
    assert pipeline.handle_run_pipeline(args) == 0

    assert seen["csv"] == layout.new.catalog.resolve()
    assert seen["output"] == layout.new.csv("_loudness").resolve()
    assert seen["output"] != loudness_link
    assert seen["stage_csv"] == layout.new.csv("_loudness").resolve()


# --- remove: joined manifest ----------------------------------------------------


def test_remove_drops_the_joined_rows_of_the_removed_output(layout: Layout) -> None:
    """The joined manifest's catalog recording is its output; the parts are only provenance."""
    joined = layout.old.csv("_joined")
    part_a, part_b, other_output = "1" * 64, "2" * 64, "3" * 64
    _write_csv(
        joined,
        ["Source Order", "Source Hash", "Output Hash"],
        [
            {"Source Order": "1", "Source Hash": part_a, "Output Hash": KEEP},
            {"Source Order": "2", "Source Hash": part_b, "Output Hash": KEEP},
            # A join whose source part is the removed hash keeps its provenance.
            {"Source Order": "1", "Source Hash": KEEP, "Output Hash": other_output},
        ],
    )

    plan = remover.build_removal_plan(
        KEEP,
        catalog_csv=layout.old.catalog,
        transcripts_root=layout.old.transcripts,
    )
    assert plan.csv_rows[joined.name] == 2

    result = remover.execute_removal(plan)
    assert result.ok, result.errors
    assert result.csv_rows_removed[joined.name] == 2
    assert _hashes(joined, "Output Hash") == [other_output]
    assert _hashes(joined, "Source Hash") == [KEEP]


def test_remove_keeps_a_staged_file_another_catalog_still_lists(layout: Layout) -> None:
    _write_csv(
        layout.old.csv("_loudness_normalized"),
        ["Hash", "Full Path"],
        [{"Hash": h, "Full Path": str(layout.new.staged[h])} for h in (GONE, KEEP)],
    )
    refs = remover.find_other_catalog_references(layout.old.catalog, KEEP)
    plan = remover.build_removal_plan(
        KEEP,
        catalog_csv=layout.old.catalog,
        transcripts_root=layout.old.transcripts,
        shared_catalog_refs=refs,
    )

    assert refs == [layout.new.catalog]
    assert plan.staged_files == []
    assert plan.shared_derived_files == [layout.new.staged[KEEP]]


def test_shared_derived_paths_parse_each_manifest_once(
    layout: Layout, monkeypatch: pytest.MonkeyPatch
) -> None:
    hashes = [GONE, KEEP]
    references = remover.find_other_catalog_references_for(layout.old.catalog, hashes)
    loads: list[Path] = []
    real_load = remover.load_csv

    def counting_load(path, **kwargs):  # type: ignore[no-untyped-def]
        loads.append(Path(path))
        return real_load(path, **kwargs)

    monkeypatch.setattr(remover, "load_csv", counting_load)

    shared = remover.shared_derived_paths_for(references)

    assert shared == {h: {layout.new.staged[h].resolve()} for h in hashes}
    assert sorted(loads) == sorted(
        {layout.new.csv("_loudness_normalized"), layout.new.csv("_loudness_archived")}
    )
    assert remover.shared_derived_paths([layout.new.catalog], KEEP) == shared[KEEP]
