"""Docker compose worker command helpers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths import PROJECT_ROOT
from besedy.lib.runtime.docker_mounts import MountSpec

DEFAULT_BACKENDS_COMPOSE_FILE = PROJECT_ROOT / "backends" / "docker-compose.yml"
DEFAULT_CONTAINER_PROJECT_ROOT = Path("/workspace/besedy")
DEFAULT_CONTAINER_CONFIG_PATH = Path("/run/besedy/config/besedy.toml")


@dataclass(frozen=True)
class DockerComposeRunSpec:
    """Describes a one-shot `docker compose run` worker invocation."""

    service: str
    argv: tuple[str, ...]
    mounts: tuple[MountSpec, ...]
    env: dict[str, str]
    compose_file: Path = DEFAULT_BACKENDS_COMPOSE_FILE
    gpus: str | None = None
    workdir: Path | None = None
    user: str | None = None


def default_docker_user() -> str | None:
    """Return a UID:GID string for compose workers when available."""

    getuid = getattr(os, "getuid", None)
    getgid = getattr(os, "getgid", None)
    if getuid is None or getgid is None:
        return None
    return f"{getuid()}:{getgid()}"


def build_compose_run_argv(spec: DockerComposeRunSpec) -> list[str]:
    """Build a deterministic `docker compose run` command."""

    argv: list[str] = [
        "docker",
        "compose",
        "-f",
        str(spec.compose_file),
        "run",
        "--rm",
        "--no-deps",
    ]
    if spec.user:
        argv.extend(["--user", spec.user])
    if spec.workdir is not None:
        argv.extend(["-w", str(spec.workdir)])

    for mount in spec.mounts:
        argv.extend(
            [
                "-v",
                (
                    f"{mount.host_path}:{mount.container_path}:"
                    f"{'ro' if mount.mode == 'ro' else 'rw'}"
                ),
            ]
        )

    for key, value in sorted(spec.env.items()):
        argv.extend(["-e", f"{key}={value}"])

    argv.append(spec.service)
    argv.extend(spec.argv)
    return argv
