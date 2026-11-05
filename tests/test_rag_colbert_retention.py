"""Bundle retention plans and deletes only old, unreferenced managed generations."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from besedy.cli.catalog import build_parser, main
from besedy.lib import rag_colbert_retention as retention
from besedy.lib.rag_bundle import (
    default_colbert_bundle_root,
    write_colbert_active_pointer,
)

GROUP = "20261001_120000"
BACKEND = "faster-whisper/large-v3@silero_vad_v6@lang-cs"
MODEL = "jinaai/jina-colbert-v2"
NOW = datetime(2026, 11, 5, 12, tzinfo=timezone.utc)
OLD = (NOW - timedelta(days=10)).timestamp()


def _bundle(root: Path, day: int, version: str = "v2") -> Path:
    model_root = default_colbert_bundle_root(
        workflow_group_id=GROUP,
        backend_key=BACKEND,
        colbert_model=MODEL,
        chunk_version=version,
        root_dir=root,
    )
    path = model_root / f"index_202610{day:02d}_120000"
    (path / "colbert_index").mkdir(parents=True)
    (path / "colbert_index" / "index.bin").write_bytes(b"index")
    for name in ("chunk_store.sqlite", "source_state.sqlite", "chunk_manifest.jsonl"):
        (path / name).write_text("data", encoding="utf-8")
    (path / "index_meta.json").write_text(
        json.dumps(
            {
                "workflow_group_id": GROUP,
                "backend_key": BACKEND,
                "colbert_model": MODEL,
                "chunk_version": version,
            }
        ),
        encoding="utf-8",
    )
    (model_root / retention.COLBERT_SYNC_LOCK_NAME).touch(exist_ok=True)
    return path


def _age(root: Path) -> None:
    for path in [*root.rglob("*"), root]:
        os.utime(path, (OLD, OLD), follow_symlinks=False)


def _activate(root: Path, bundle: Path) -> Path:
    link = bundle.parent / "index"
    link.unlink(missing_ok=True)
    link.symlink_to(bundle.name, target_is_directory=True)
    return write_colbert_active_pointer(
        workflow_group_id=GROUP,
        backend_key=BACKEND,
        colbert_model=MODEL,
        chunk_version=bundle.parent.parent.name,
        index_dir=link,
        root_dir=root,
    )


def _prune(root: Path, **options):
    return retention.prune_colbert_bundles(
        workflow_group_id=GROUP,
        backend_key=BACKEND,
        colbert_model=MODEL,
        root_dir=root,
        now=NOW,
        **options,
    )


def _eligible(result) -> list[Path]:
    return [Path(entry.path) for entry in result.entries if not entry.keep_reasons]


def test_dry_run_keeps_newest_three_including_active_without_deleting(tmp_path: Path) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 6)]
    _activate(tmp_path, bundles[-1])
    _age(tmp_path)

    result = _prune(tmp_path)

    assert _eligible(result) == bundles[:2]
    assert not any(entry.removed for entry in result.entries)
    assert all(bundle.is_dir() for bundle in bundles)
    assert all(entry.size_bytes > 0 for entry in result.entries if Path(entry.path) in bundles)


def test_execute_preserves_older_active_and_cross_scope_references(tmp_path: Path) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 7)]
    _activate(tmp_path, bundles[0])
    other = tmp_path / "20261002_120000" / "other-backend" / "active_custom.json"
    other.parent.mkdir(parents=True)
    other.write_text(
        json.dumps(
            {
                "chunk_version": "v2",
                "index_dir": str(bundles[1] / "colbert_index"),
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "saved-index").symlink_to(bundles[2], target_is_directory=True)
    _age(tmp_path)

    result = _prune(tmp_path, keep=2, execute=True)

    assert [Path(entry.path) for entry in result.entries if entry.removed] == [bundles[3]]
    assert all(bundle.is_dir() for bundle in [*bundles[:3], *bundles[-2:]])
    assert not bundles[3].exists()
    assert (bundles[0].parent / "index").resolve() == bundles[0]


def test_keep_window_orders_same_second_suffixes_numerically(tmp_path: Path) -> None:
    first = _bundle(tmp_path, 1)
    first.rename(first.with_name(f"{first.name}_2"))
    second = _bundle(tmp_path, 1)
    second = second.rename(second.with_name(f"{second.name}_10"))
    _age(tmp_path)

    result = _prune(tmp_path, keep=1)

    newest = next(entry for entry in result.entries if Path(entry.path) == second)
    assert "among the newest 1 valid generations" in newest.keep_reasons
    assert _eligible(result) == [first.with_name(f"{first.name}_2")]


@pytest.mark.parametrize("changed", ["pointer", "symlink", "scope", "bundle"])
def test_recent_changes_preserve_reader_grace(tmp_path: Path, changed: str) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 5)]
    pointer = _activate(tmp_path, bundles[-1])
    _age(tmp_path)
    path = {
        "pointer": pointer,
        "symlink": bundles[-1].parent / "index",
        "scope": bundles[-1].parent,
        "bundle": bundles[0] / "index_meta.json",
    }[changed]
    recent = (NOW - timedelta(hours=1)).timestamp()
    os.utime(path, (recent, recent), follow_symlinks=False)

    result = _prune(tmp_path, execute=True)

    assert not _eligible(result)
    assert all(bundle.is_dir() for bundle in bundles)


def test_newest_window_spans_chunk_versions_and_locks_each_before_reading(
    tmp_path: Path, monkeypatch
) -> None:
    bundles = [_bundle(tmp_path, 1, "v1"), _bundle(tmp_path, 2), _bundle(tmp_path, 3)]
    _activate(tmp_path, bundles[-1])
    _age(tmp_path)
    held: set[Path] = set()
    original_lock = retention.exclusive_lock
    original_references = retention._reference_snapshot

    @contextmanager
    def lock(path: Path):
        with original_lock(path):
            held.add(path)
            try:
                yield
            finally:
                held.remove(path)

    def references(root: Path):
        assert held == {bundle.parent / retention.COLBERT_SYNC_LOCK_NAME for bundle in bundles}
        return original_references(root)

    monkeypatch.setattr(retention, "exclusive_lock", lock)
    monkeypatch.setattr(retention, "_reference_snapshot", references)

    result = _prune(tmp_path, keep=2)

    assert _eligible(result) == bundles[:1]
    assert not held


@pytest.mark.parametrize(
    "damage", ["not JSON", "{}", '{"index_dir":"/missing","chunk_version":"v2"}']
)
def test_malformed_or_unresolved_pointer_aborts_before_any_deletion(
    tmp_path: Path, damage: str
) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 5)]
    pointer = _activate(tmp_path, bundles[-1])
    pointer.write_text(damage, encoding="utf-8")
    _age(tmp_path)

    with pytest.raises(ValueError, match="Cannot safely read active ColBERT pointer"):
        _prune(tmp_path, execute=True)

    assert all(bundle.is_dir() for bundle in bundles)


def test_unknown_incomplete_and_symlinked_bundles_are_never_deleted(tmp_path: Path) -> None:
    active = _bundle(tmp_path, 5)
    incomplete = _bundle(tmp_path, 1)
    (incomplete / "source_state.sqlite").unlink()
    wrong_metadata = _bundle(tmp_path, 2)
    (wrong_metadata / "index_meta.json").write_text("{}", encoding="utf-8")
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (outside / "important").write_text("keep", encoding="utf-8")
    alias = active.parent / "index_20261003_120000"
    alias.symlink_to(outside, target_is_directory=True)
    nested_symlink = _bundle(tmp_path, 4)
    (nested_symlink / "external").symlink_to(outside, target_is_directory=True)
    unknown = active.parent / "operator-notes"
    unknown.mkdir()
    _activate(tmp_path, active)
    _age(tmp_path)

    result = _prune(tmp_path, keep=1, execute=True)

    assert not any(entry.removed for entry in result.entries)
    assert all(entry.keep_reasons for entry in result.entries)
    assert outside.joinpath("important").read_text(encoding="utf-8") == "keep"
    assert alias.is_symlink() and unknown.is_dir() and incomplete.is_dir()


def test_rechecks_other_scope_pointer_before_deleting(tmp_path: Path, monkeypatch) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 5)]
    _activate(tmp_path, bundles[-1])
    _age(tmp_path)
    original = retention._reference_snapshot
    calls = 0

    def references(root: Path):
        nonlocal calls
        calls += 1
        if calls == 2:
            other = tmp_path / "other" / "active_custom.json"
            other.parent.mkdir()
            other.write_text(
                json.dumps(
                    {
                        "chunk_version": "v2",
                        "index_dir": str(bundles[0] / "colbert_index"),
                    }
                ),
                encoding="utf-8",
            )
        return original(root)

    monkeypatch.setattr(retention, "_reference_snapshot", references)

    result = _prune(tmp_path, execute=True)

    assert calls == 2
    assert bundles[0].is_dir()
    entry = next(entry for entry in result.entries if Path(entry.path) == bundles[0])
    assert "reference changed since retention was planned" in entry.keep_reasons


@pytest.mark.parametrize(
    "change",
    [
        "remove",
        "repoint-in-place",
        "replace-atomically",
        "remove-directory",
        "remove-symlink",
        "repoint-symlink",
        "edit-symlinked-pointer",
    ],
)
def test_recent_foreign_reference_changes_defer_former_target_cleanup(
    tmp_path: Path, change: str
) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 5)]
    _activate(tmp_path, bundles[-1])
    foreign = tmp_path / "other" / "active_custom.json"
    foreign.parent.mkdir()

    def payload(bundle: Path) -> str:
        return json.dumps({"chunk_version": "v2", "index_dir": str(bundle / "colbert_index")})

    if change in {"remove-symlink", "repoint-symlink"}:
        foreign = foreign.with_name("saved-index")
        foreign.symlink_to(bundles[0], target_is_directory=True)
    elif change == "edit-symlinked-pointer":
        target = foreign.with_name("reference.json")
        target.write_text(payload(bundles[0]), encoding="utf-8")
        foreign.symlink_to(target.name)
    else:
        foreign.write_text(payload(bundles[0]), encoding="utf-8")
    _age(tmp_path)
    previous_directory_mtime = foreign.parent.stat().st_mtime_ns

    if change in {"remove", "remove-symlink"}:
        foreign.unlink()
    elif change == "remove-directory":
        retention.shutil.rmtree(foreign.parent)
    elif change == "repoint-in-place":
        foreign.write_text(payload(bundles[-1]), encoding="utf-8")
        assert foreign.parent.stat().st_mtime_ns == previous_directory_mtime
    elif change == "replace-atomically":
        temporary = foreign.with_suffix(".tmp")
        temporary.write_text(payload(bundles[-1]), encoding="utf-8")
        temporary.replace(foreign)
    elif change == "repoint-symlink":
        foreign.unlink()
        foreign.symlink_to(bundles[-1], target_is_directory=True)
    else:
        foreign.resolve().write_text(payload(bundles[-1]), encoding="utf-8")
        assert foreign.parent.stat().st_mtime_ns == previous_directory_mtime

    result = _prune(tmp_path, execute=True)

    assert not any(entry.removed for entry in result.entries)
    former_target = next(entry for entry in result.entries if Path(entry.path) == bundles[0])
    assert "root reference/directory activity within 24 hours" in former_target.keep_reasons
    assert bundles[0].is_dir()


def test_own_deletions_do_not_interrupt_a_batch(tmp_path: Path) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 7)]
    _activate(tmp_path, bundles[-1])
    _age(tmp_path)

    result = _prune(tmp_path, keep=2, execute=True)

    assert [Path(entry.path) for entry in result.entries if entry.removed] == bundles[:4]
    assert all(bundle.is_dir() for bundle in bundles[-2:])


def test_own_deletion_does_not_acknowledge_a_foreign_pointer_removal(
    tmp_path: Path, monkeypatch
) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 6)]
    _activate(tmp_path, bundles[-1])
    foreign = tmp_path / "other" / "active_custom.json"
    foreign.parent.mkdir()
    foreign.write_text(
        json.dumps(
            {
                "chunk_version": "v2",
                "index_dir": str(bundles[-1] / "colbert_index"),
            }
        ),
        encoding="utf-8",
    )
    _age(tmp_path)
    original = retention.shutil.rmtree

    def remove(path: Path):
        original(path)
        if path == bundles[0]:
            foreign.unlink()

    monkeypatch.setattr(retention.shutil, "rmtree", remove)

    result = _prune(tmp_path, keep=2, execute=True)

    assert [Path(entry.path) for entry in result.entries if entry.removed] == bundles[:1]
    assert all(bundle.is_dir() for bundle in bundles[1:])
    remaining = next(entry for entry in result.entries if Path(entry.path) == bundles[1])
    assert "root activity changed since retention was planned" in remaining.keep_reasons


def test_generation_containing_a_reference_is_retained(tmp_path: Path) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 6)]
    _activate(tmp_path, bundles[-1])
    (bundles[0] / "active_custom.json").write_text(
        json.dumps(
            {
                "chunk_version": "v2",
                "index_dir": str(bundles[1] / "colbert_index"),
            }
        ),
        encoding="utf-8",
    )
    _age(tmp_path)

    result = _prune(tmp_path, keep=2, execute=True)

    assert [Path(entry.path) for entry in result.entries if entry.removed] == [bundles[2]]
    assert bundles[0].is_dir() and bundles[1].is_dir()


def test_scope_symlink_cannot_redirect_deletion_outside_configured_root(tmp_path: Path) -> None:
    real_root = tmp_path / "outside"
    bundle = _bundle(real_root, 1)
    root = tmp_path / "configured"
    root.mkdir()
    (root / GROUP).symlink_to(real_root / GROUP, target_is_directory=True)

    with pytest.raises(ValueError, match="scope contains a symlink"):
        _prune(root, execute=True)

    assert bundle.is_dir()


def test_cli_defaults_to_dry_run_with_machine_readable_plan(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    bundles = [_bundle(tmp_path, day) for day in range(1, 5)]
    _activate(tmp_path, bundles[-1])
    _age(tmp_path)
    monkeypatch.setattr("besedy.lib.rag_bundle.DEFAULT_COLBERT_BUNDLE_ROOT", tmp_path)
    argv = ["rag-colbert-prune", "--group", GROUP, "--backend", BACKEND, "--model", MODEL, "--json"]
    args = build_parser().parse_args(argv)
    assert args.keep == 3 and args.min_age_hours == 24 and args.execute is False

    assert main(argv) == 0

    result = json.loads(capsys.readouterr().out)
    assert result["result"]["execute"] is False
    assert all(bundle.is_dir() for bundle in bundles)
    for option in ("--keep", "--min-age-hours"):
        with pytest.raises(SystemExit):
            build_parser().parse_args([*argv, option, "0"])


def test_cli_refuses_traversal_scope(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="workflow_group_id"):
        retention.prune_colbert_bundles(
            workflow_group_id="../elsewhere",
            backend_key=BACKEND,
            colbert_model=MODEL,
            root_dir=tmp_path,
            execute=True,
        )
