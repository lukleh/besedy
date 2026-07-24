"""Runtime selection and Docker path planning for the ColBERT facade.

This module deliberately contains no indexing orchestration.  It owns the stable
boundary between host-side paths/runtime configuration and the payloads accepted
by the containerized ColBERT workers.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Any

from besedy.core.paths import PROJECT_ROOT

COLBERT_DOCKER_COMPOSE_FILE = PROJECT_ROOT / "rag-services" / "docker-compose.yml"
COLBERT_DOCKER_SERVICE = "colbert"
COLBERT_DOCKER_INDEXER_SERVICE = "colbert-indexer"
COLBERT_DOCKER_INDEXER_PROFILE = "colbert-indexer"
COLBERT_DOCKER_PROJECT_ROOT = PurePosixPath("/workspace/besedy")
COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR = PurePosixPath("/workspace/colbert-indexer-bundle")
# Scratch dir for the Dockerized ColBERT indexer, injected into the container as
# TMPDIR/TMP/TEMP. Defaults to /tmp (always present in-container); override via
# the TMPDIR env var for big corpora, but that path must exist in the container
# (mount a volume there) — the value is passed through verbatim.
COLBERT_DOCKER_INDEXER_TMPDIR = os.getenv("TMPDIR") or "/tmp"
COLBERT_DOCKER_INDEXER_TORCH_EXTENSIONS_DIR = "/data/torch/extensions"
COLBERT_RUNTIME_ENV_VAR = "BESEDY_COLBERT_RUNTIME"
COLBERT_RUNTIME_DOCKER = "docker"
COLBERT_RUNTIME_DOCKER_INDEXER = "docker-indexer"
COLBERT_RUNTIME_CHOICES = (
    COLBERT_RUNTIME_DOCKER,
    COLBERT_RUNTIME_DOCKER_INDEXER,
)
COLBERT_DOCKER_UP_COMMAND = (
    "docker compose -f rag-services/docker-compose.yml up -d --build colbert"
)
COLBERT_DOCKER_INDEXER_RUN_COMMAND = (
    "docker compose -f rag-services/docker-compose.yml --profile colbert-indexer "
    "run --rm --no-deps colbert-indexer build-index"
)
COLBERT_DOCKER_QUERY_HOST = "127.0.0.1"
COLBERT_DOCKER_QUERY_PORT = 8192


def normalize_colbert_runtime(raw_value: str, *, source: str) -> str:
    """Normalize and validate a runtime value from a named configuration source."""

    normalized = raw_value.strip().lower()
    if normalized in COLBERT_RUNTIME_CHOICES:
        return normalized

    expected = ", ".join(repr(choice) for choice in COLBERT_RUNTIME_CHOICES)
    raise RuntimeError(f"Unsupported {source} value: {raw_value!r}. Expected one of: {expected}.")


def host_has_nvidia_gpu() -> bool:
    """Return True when the current host exposes at least one NVIDIA GPU."""

    if shutil.which("nvidia-smi") is None:
        return False

    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            text=True,
            capture_output=True,
            check=True,
        )
    except (subprocess.CalledProcessError, OSError):
        return False

    return any(line.strip() for line in result.stdout.splitlines())


def default_colbert_index_runtime(
    *, has_nvidia_gpu: Callable[[], bool] = host_has_nvidia_gpu
) -> str:
    """Return the preferred ColBERT indexing runtime for the current host."""

    if has_nvidia_gpu():
        return COLBERT_RUNTIME_DOCKER_INDEXER
    return COLBERT_RUNTIME_DOCKER


def resolve_colbert_runtime(runtime_override: str | None = None) -> str:
    """Resolve an explicit runtime or the environment-configured default."""

    if runtime_override is not None:
        return normalize_colbert_runtime(runtime_override, source="ColBERT runtime override")

    raw_value = os.getenv(COLBERT_RUNTIME_ENV_VAR, COLBERT_RUNTIME_DOCKER)
    return normalize_colbert_runtime(raw_value, source=COLBERT_RUNTIME_ENV_VAR)


def docker_project_path(path: Path | str) -> str:
    """Translate a repository-local host path into the worker container path."""

    candidate = Path(path)
    resolved = (
        candidate.resolve() if candidate.is_absolute() else (PROJECT_ROOT / candidate).resolve()
    )
    try:
        relative = resolved.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise RuntimeError(
            f"ColBERT Docker runtime only supports paths under the repository root: {resolved}"
        ) from exc
    return str(COLBERT_DOCKER_PROJECT_ROOT / relative.as_posix())


def docker_runtime_supports_path(path: Path | str) -> bool:
    """Return whether a path is addressable by the long-lived Docker worker."""

    try:
        docker_project_path(path)
    except RuntimeError:
        return False
    return True


def docker_worker_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Translate repository-local paths in a worker payload."""

    translated = dict(payload)
    for key in ("manifest_path", "colbert_index_dir"):
        value = translated.get(key)
        if isinstance(value, str):
            translated[key] = docker_project_path(value)
    return translated


def docker_bundle_payload_context(
    payload: dict[str, Any],
) -> tuple[dict[str, Any], list[str], str]:
    """Plan payload paths and mounts for a possibly external index bundle."""

    bundle_dir = Path(str(payload["colbert_index_dir"])).resolve().parent
    if docker_runtime_supports_path(bundle_dir):
        return docker_worker_payload(payload), [], docker_project_path(bundle_dir)

    translated = dict(payload)
    for key in ("manifest_path", "colbert_index_dir"):
        value = translated.get(key)
        if not isinstance(value, str):
            continue
        resolved = Path(value).resolve()
        try:
            relative = resolved.relative_to(bundle_dir)
        except ValueError as exc:
            raise RuntimeError(
                "ColBERT Docker indexer expected bundle-local paths for build-index payloads: "
                f"{resolved}"
            ) from exc
        translated[key] = str(COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR / relative.as_posix())

    return (
        translated,
        ["-v", f"{bundle_dir}:{COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR}:rw"],
        str(COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR),
    )
