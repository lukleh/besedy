from __future__ import annotations

from pathlib import Path

import pytest

from besedy.lib.runtime.docker_mounts import (
    build_path_map,
    collapse_mounts,
    make_mount,
    rewrite_path,
)


def test_collapse_mounts_drops_redundant_child_with_same_mode(tmp_path: Path) -> None:
    parent = tmp_path / "data"
    child = parent / "nested"
    child.mkdir(parents=True)

    collapsed = collapse_mounts(
        [
            make_mount(host_path=parent, mode="ro", kind="input"),
            make_mount(host_path=child, mode="ro", kind="input"),
        ]
    )

    assert collapsed == [make_mount(host_path=parent, mode="ro", kind="input")]


def test_collapse_mounts_keeps_rw_child_under_ro_parent(tmp_path: Path) -> None:
    parent = tmp_path / "data"
    child = parent / "tmp"
    child.mkdir(parents=True)

    collapsed = collapse_mounts(
        [
            make_mount(host_path=parent, mode="ro", kind="input"),
            make_mount(host_path=child, mode="rw", kind="temp"),
        ]
    )

    assert len(collapsed) == 2
    assert collapsed[0].host_path == parent
    assert collapsed[1].host_path == child


def test_collapse_mounts_rejects_overlapping_container_paths_for_unrelated_hosts(
    tmp_path: Path,
) -> None:
    host_a = tmp_path / "a"
    host_b = tmp_path / "b"
    host_a.mkdir()
    host_b.mkdir()

    mounts = [
        make_mount(host_path=host_a, container_path=Path("/data"), mode="ro", kind="input"),
        make_mount(host_path=host_b, container_path=Path("/data/sub"), mode="ro", kind="input"),
    ]

    with pytest.raises(RuntimeError, match="overlapping container paths"):
        collapse_mounts(mounts)


def test_build_path_map_rewrites_longest_matching_prefix(tmp_path: Path) -> None:
    host = tmp_path / "host"
    nested = host / "nested"
    nested.mkdir(parents=True)

    mounts = [
        make_mount(host_path=host, container_path=Path("/mnt/host"), mode="ro", kind="input"),
        make_mount(
            host_path=nested,
            container_path=Path("/mnt/nested"),
            mode="ro",
            kind="input",
        ),
    ]

    path_map = build_path_map(mounts)

    rewritten = rewrite_path(nested / "file.wav", path_map)
    assert rewritten == "/mnt/nested/file.wav"
