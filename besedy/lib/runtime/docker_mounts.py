"""Helpers for planning per-invocation Docker bind mounts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

MountMode = Literal["ro", "rw"]
MountKind = Literal["code", "config", "input", "output", "temp", "cache", "model"]


@dataclass(frozen=True)
class MountSpec:
    """A single bind mount for a containerized worker."""

    host_path: Path
    container_path: Path
    mode: MountMode
    kind: MountKind
    preserve_host_path: bool = True


def _abspath_no_resolve(path: Path | str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate
    return Path.cwd() / candidate


def _is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def make_mount(
    *,
    host_path: Path | str,
    container_path: Path | str | None = None,
    mode: MountMode,
    kind: MountKind,
    preserve_host_path: bool = True,
) -> MountSpec:
    """Create a normalized mount specification."""

    host = _abspath_no_resolve(host_path)
    container = _abspath_no_resolve(container_path or host)
    return MountSpec(
        host_path=host,
        container_path=container,
        mode=mode,
        kind=kind,
        preserve_host_path=preserve_host_path,
    )


def collapse_mounts(mounts: list[MountSpec]) -> list[MountSpec]:
    """Collapse redundant mounts while preserving explicit write exceptions.

    Rules:
    - identical host/container targets are merged, preferring `rw`
    - same host path with different container targets is rejected
    - parent mounts with the same mode absorb child mounts when their container
      path relationship is the same
    - overlapping container paths backed by unrelated host paths are rejected
    """

    if not mounts:
        return []

    normalized = [
        MountSpec(
            host_path=_abspath_no_resolve(spec.host_path),
            container_path=_abspath_no_resolve(spec.container_path),
            mode=spec.mode,
            kind=spec.kind,
            preserve_host_path=spec.preserve_host_path,
        )
        for spec in mounts
    ]

    deduped: dict[tuple[Path, Path], MountSpec] = {}
    host_targets: dict[Path, Path] = {}

    for spec in normalized:
        existing_target = host_targets.get(spec.host_path)
        if existing_target is not None and existing_target != spec.container_path:
            raise RuntimeError(
                "Conflicting Docker mount plan: "
                f"{spec.host_path} mapped to both {existing_target} and {spec.container_path}"
            )
        host_targets[spec.host_path] = spec.container_path

        key = (spec.host_path, spec.container_path)
        existing = deduped.get(key)
        if existing is None:
            deduped[key] = spec
            continue

        merged_mode: MountMode = "rw" if "rw" in {existing.mode, spec.mode} else "ro"
        deduped[key] = MountSpec(
            host_path=spec.host_path,
            container_path=spec.container_path,
            mode=merged_mode,
            kind=existing.kind,
            preserve_host_path=existing.preserve_host_path and spec.preserve_host_path,
        )

    sorted_mounts = sorted(
        deduped.values(),
        key=lambda spec: (
            len(spec.host_path.parts),
            len(spec.container_path.parts),
            spec.host_path.as_posix(),
            spec.container_path.as_posix(),
        ),
    )

    kept: list[MountSpec] = []
    for candidate in sorted_mounts:
        skip_candidate = False
        for existing in kept:
            if candidate.host_path == existing.host_path:
                if candidate.container_path != existing.container_path:
                    raise RuntimeError(
                        "Conflicting Docker mount plan: "
                        f"{candidate.host_path} mapped to both "
                        f"{existing.container_path} and {candidate.container_path}"
                    )
                if existing.mode == "rw" or candidate.mode == existing.mode:
                    skip_candidate = True
                    break
                continue

            host_nested = _is_relative_to(candidate.host_path, existing.host_path)
            container_nested = _is_relative_to(candidate.container_path, existing.container_path)

            if host_nested and container_nested:
                rel_host = candidate.host_path.relative_to(existing.host_path)
                rel_container = candidate.container_path.relative_to(existing.container_path)
                if rel_host == rel_container:
                    if existing.mode == candidate.mode or existing.mode == "rw":
                        skip_candidate = True
                        break
                    if existing.mode == "ro" and candidate.mode == "rw":
                        continue

            container_overlap = container_nested or _is_relative_to(
                existing.container_path, candidate.container_path
            )
            host_overlap = host_nested or _is_relative_to(existing.host_path, candidate.host_path)
            if container_overlap and not host_overlap:
                raise RuntimeError(
                    "Conflicting Docker mount plan: overlapping container paths "
                    f"{existing.container_path} and {candidate.container_path} are backed by "
                    "different host roots"
                )

        if not skip_candidate:
            kept.append(candidate)

    return kept


def build_path_map(mounts: list[MountSpec]) -> dict[str, str]:
    """Return host->container path rewrites for mounts that are not same-path."""

    path_map: dict[str, str] = {}
    for spec in sorted(
        mounts,
        key=lambda item: len(item.host_path.as_posix()),
        reverse=True,
    ):
        if spec.host_path != spec.container_path:
            path_map[str(spec.host_path)] = str(spec.container_path)
    return path_map


def rewrite_path(path: str | Path, path_map: dict[str, str]) -> str:
    """Rewrite an absolute path using the longest matching mount prefix."""

    raw = str(path)
    for host_prefix, container_prefix in sorted(
        path_map.items(), key=lambda item: len(item[0]), reverse=True
    ):
        if raw == host_prefix or raw.startswith(f"{host_prefix}/"):
            return raw.replace(host_prefix, container_prefix, 1)
    return raw
