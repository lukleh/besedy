"""Shared backend runtime selection and process builders."""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from besedy.config.settings import resolve_config_path
from besedy.core.paths import PROJECT_ROOT
from besedy.lib.runtime.docker_mounts import MountSpec, collapse_mounts, make_mount
from besedy.lib.runtime.docker_worker import (
    DEFAULT_BACKENDS_COMPOSE_FILE,
    DEFAULT_CONTAINER_CONFIG_PATH,
    DEFAULT_CONTAINER_PROJECT_ROOT,
    DockerComposeRunSpec,
    build_compose_run_argv,
    default_docker_user,
)

BackendRuntime = Literal["isolated", "docker"]
BACKEND_RUNTIME_CHOICES: tuple[BackendRuntime, ...] = ("isolated", "docker")
DOCKER_ONLY_BACKENDS: frozenset[str] = frozenset(
    {
        "pyannote",
        "faster-whisper",
        "qwen3-asr",
        "whisperx",
        "nemo",
    }
)
DOCKER_DEFAULT_BACKENDS = DOCKER_ONLY_BACKENDS
DOCKER_GPU_REQUIRED_BACKENDS: frozenset[str] = frozenset(
    {
        "pyannote",
        "faster-whisper",
        "qwen3-asr",
        "whisperx",
        "nemo",
    }
)


@dataclass(frozen=True)
class BackendProcessSpec:
    """Subprocess launch data for a backend worker."""

    argv: tuple[str, ...]
    extra_env: dict[str, str] | None = None
    runtime: BackendRuntime = "isolated"


def _backend_token(backend_id: str) -> str:
    return backend_id.replace("-", "_").upper()


def backend_runtime_env_var_name(backend_id: str) -> str:
    """Return the env var controlling the backend runtime."""

    return f"BESEDY_{_backend_token(backend_id)}_RUNTIME"


def backend_cache_env_var_name(backend_id: str) -> str:
    """Return the env var controlling the backend cache root."""

    return f"BESEDY_{_backend_token(backend_id)}_CACHE_DIR"


def forward_host_env(*names: str) -> dict[str, str]:
    """Collect selected host env vars for worker subprocesses."""

    forwarded: dict[str, str] = {}
    for name in names:
        value = os.getenv(name)
        if value:
            forwarded[name] = value
    return forwarded


def _supported_backend_runtime_choices(backend_id: str | None) -> tuple[BackendRuntime, ...]:
    if backend_id in DOCKER_ONLY_BACKENDS:
        return ("docker",)
    return BACKEND_RUNTIME_CHOICES


def normalize_backend_runtime(
    raw_value: str,
    *,
    source: str,
    backend_id: str | None = None,
) -> BackendRuntime:
    """Validate and normalize a backend runtime selector."""

    normalized = raw_value.strip().lower()
    choices = _supported_backend_runtime_choices(backend_id)
    if normalized in choices:
        return cast(BackendRuntime, normalized)
    choices_label = ", ".join(repr(choice) for choice in choices)
    if backend_id in DOCKER_ONLY_BACKENDS:
        raise RuntimeError(
            f"Unsupported {source} value: {raw_value!r}. "
            f"The {backend_id} backend is Docker-only. Expected one of {choices_label}."
        )
    raise RuntimeError(
        f"Unsupported {source} value: {raw_value!r}. Expected one of {choices_label}."
    )


def resolve_backend_runtime(
    backend_id: str,
    *,
    runtime_override: str | None = None,
) -> BackendRuntime:
    """Resolve the active runtime for a backend."""

    if runtime_override is not None:
        return normalize_backend_runtime(
            runtime_override,
            source="backend runtime override",
            backend_id=backend_id,
        )
    env_var = backend_runtime_env_var_name(backend_id)
    default_runtime = "docker" if backend_id in DOCKER_DEFAULT_BACKENDS else "isolated"
    raw = os.getenv(env_var, default_runtime)
    return normalize_backend_runtime(raw, source=env_var, backend_id=backend_id)


def _abspath_no_resolve(path: Path | str) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return candidate
    return Path.cwd() / candidate


def _prepend_env_path(prefix: str, existing: str | None) -> str:
    if not existing:
        return prefix
    if existing.split(os.pathsep)[0] == prefix:
        return existing
    return f"{prefix}{os.pathsep}{existing}"


def _check_isolated_python_available(env_python: Path) -> bool:
    return env_python.exists() and env_python.is_file()


def resolve_local_model_path(value: str | Path | None) -> Path | None:
    """Resolve a local model path when the provided value points to the filesystem."""

    if value is None:
        return None

    raw = str(value).strip()
    if not raw:
        return None

    candidate = Path(raw).expanduser()
    explicit_path = candidate.is_absolute() or raw.startswith(("~", "./", "../", ".\\", "..\\"))
    if explicit_path:
        return _abspath_no_resolve(candidate) if candidate.exists() else None
    if candidate.exists():
        return _abspath_no_resolve(candidate)
    return None


def resolve_backend_cache_dir(backend_id: str) -> Path:
    """Resolve the stable host cache root for a backend."""

    xdg_cache = _abspath_no_resolve(os.getenv("XDG_CACHE_HOME", Path.home() / ".cache"))
    backend_cache_var = backend_cache_env_var_name(backend_id)
    return _abspath_no_resolve(os.getenv(backend_cache_var, xdg_cache / "besedy" / backend_id))


def _default_cache_paths(backend_id: str) -> tuple[dict[str, str], list[Path]]:
    xdg_cache = _abspath_no_resolve(os.getenv("XDG_CACHE_HOME", Path.home() / ".cache"))
    docker_home = _abspath_no_resolve(os.getenv("BESEDY_DOCKER_HOME", xdg_cache / "home"))
    docker_user = os.getenv("USER") or os.getenv("LOGNAME") or f"uid{os.getuid()}"
    hf_home = _abspath_no_resolve(os.getenv("HF_HOME", xdg_cache / "huggingface"))
    hf_hub = _abspath_no_resolve(os.getenv("HF_HUB_CACHE", hf_home / "hub"))
    transformers = _abspath_no_resolve(os.getenv("TRANSFORMERS_CACHE", hf_home / "transformers"))
    torch_home = _abspath_no_resolve(os.getenv("TORCH_HOME", xdg_cache / "torch"))
    mpl_config = _abspath_no_resolve(os.getenv("MPLCONFIGDIR", xdg_cache / "matplotlib"))
    nltk_data = _abspath_no_resolve(os.getenv("NLTK_DATA", xdg_cache / "nltk_data"))
    backend_cache_var = backend_cache_env_var_name(backend_id)
    backend_cache = resolve_backend_cache_dir(backend_id)

    env = {
        "HOME": str(docker_home),
        "USER": docker_user,
        "LOGNAME": docker_user,
        "XDG_CACHE_HOME": str(xdg_cache),
        "HF_HOME": str(hf_home),
        "HF_HUB_CACHE": str(hf_hub),
        "TRANSFORMERS_CACHE": str(transformers),
        "TORCH_HOME": str(torch_home),
        "MPLCONFIGDIR": str(mpl_config),
        "NLTK_DATA": str(nltk_data),
        backend_cache_var: str(backend_cache),
    }
    return env, [
        xdg_cache,
        docker_home,
        hf_home,
        hf_hub,
        transformers,
        torch_home,
        mpl_config,
        nltk_data,
        backend_cache,
    ]


def _prepare_mount_root(path: Path | str, *, create: bool = False) -> Path:
    candidate = _abspath_no_resolve(path)
    if candidate.exists():
        return candidate.parent if candidate.is_file() else candidate

    if candidate.suffix:
        root = candidate.parent
    else:
        root = candidate

    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root


def _mounts_for_roots(
    roots: list[Path | str],
    *,
    kind: Literal["input", "output", "temp", "cache", "model"],
    mode: Literal["ro", "rw"],
    create: bool = False,
) -> list[MountSpec]:
    mounts: list[MountSpec] = []
    for root in roots:
        resolved_root = _prepare_mount_root(root, create=create)
        if not resolved_root.exists() and mode == "ro":
            continue
        mounts.append(
            make_mount(
                host_path=resolved_root,
                mode=mode,
                kind=kind,
            )
        )
    return mounts


def _docker_runtime_ready(
    *,
    display_name: str,
    docker_service: str | None,
    compose_file: Path,
) -> tuple[bool, str | None]:
    if docker_service is None:
        return False, f"{display_name} Docker runtime is not configured yet."
    if shutil.which("docker") is None:
        return False, "Docker runtime selected but `docker` is not installed or not in PATH."
    if not compose_file.exists():
        return False, f"{display_name} Docker compose file not found: {compose_file}"
    return True, None


def check_python_backend_runtime_ready(
    *,
    backend_id: str,
    display_name: str,
    isolated_python: Path | None = None,
    setup_script: str | None = None,
    docker_service: str | None = None,
    runtime_override: str | None = None,
    compose_file: Path = DEFAULT_BACKENDS_COMPOSE_FILE,
    required_paths: list[Path] | None = None,
    isolated_ready_check: Callable[[], object] | None = None,
) -> tuple[bool, str | None]:
    """Check whether the selected runtime is ready for a Python backend."""

    runtime = resolve_backend_runtime(backend_id, runtime_override=runtime_override)
    if runtime == "isolated":
        if isolated_python is None or setup_script is None:
            raise RuntimeError(
                f"{display_name} isolated runtime is not configured for this caller."
            )
        if _check_isolated_python_available(isolated_python):
            if isolated_ready_check is not None:
                try:
                    isolated_ready_check()
                except Exception as exc:
                    return False, str(exc)
            missing_paths = [
                str(path)
                for path in (required_paths or [])
                if not _abspath_no_resolve(path).exists()
            ]
            if not missing_paths:
                return True, None
            return (
                False,
                f"{display_name} runtime is missing required files: {', '.join(missing_paths)}",
            )
        return False, f"{display_name} environment not set up. Run: ./besedy/scripts/{setup_script}"
    return _docker_runtime_ready(
        display_name=display_name,
        docker_service=docker_service,
        compose_file=compose_file,
    )


def _validate_docker_gpu_request(
    *,
    backend_id: str,
    display_name: str,
    docker_gpus: str | None,
) -> None:
    if backend_id in DOCKER_GPU_REQUIRED_BACKENDS and docker_gpus is None:
        raise RuntimeError(
            f"{display_name} Docker runtime is GPU-only in Besedy. "
            "Remove --cpu and run on a GPU-enabled Docker host."
        )


def _build_docker_mounts(
    *,
    backend_id: str,
    include_project_root: bool,
    include_config: bool,
    input_paths: list[Path | str],
    output_paths: list[Path | str],
    temp_paths: list[Path | str],
    model_paths: list[Path | str],
    cache_paths: list[Path | str],
) -> list[MountSpec]:
    mounts: list[MountSpec] = []
    if include_project_root:
        mounts.append(
            make_mount(
                host_path=PROJECT_ROOT,
                container_path=DEFAULT_CONTAINER_PROJECT_ROOT,
                mode="ro",
                kind="code",
                preserve_host_path=False,
            )
        )
    if include_config:
        config_path = resolve_config_path()
        mounts.append(
            make_mount(
                host_path=config_path,
                container_path=DEFAULT_CONTAINER_CONFIG_PATH,
                mode="ro",
                kind="config",
                preserve_host_path=False,
            )
        )

    mounts.extend(_mounts_for_roots(input_paths, kind="input", mode="ro"))
    mounts.extend(_mounts_for_roots(output_paths, kind="output", mode="rw", create=True))
    mounts.extend(_mounts_for_roots(temp_paths, kind="temp", mode="rw", create=True))
    mounts.extend(_mounts_for_roots(model_paths, kind="model", mode="ro"))
    mounts.extend(_mounts_for_roots(cache_paths, kind="cache", mode="rw", create=True))
    mounts = collapse_mounts(mounts)

    for spec in mounts:
        if spec.kind in {"code", "config"}:
            continue
        if spec.preserve_host_path and spec.host_path != spec.container_path:
            raise RuntimeError(
                "Docker runtime requires same-path data mounts for current workers. "
                f"Unsupported mapping for {backend_id}: {spec.host_path} -> {spec.container_path}"
            )
    return mounts


def build_python_backend_process(
    *,
    backend_id: str,
    display_name: str,
    isolated_python: Path | None = None,
    setup_script: str | None = None,
    script_path: Path,
    script_args: list[str],
    docker_service: str | None = None,
    runtime_override: str | None = None,
    extra_env: dict[str, str] | None = None,
    input_paths: list[Path | str] | None = None,
    output_paths: list[Path | str] | None = None,
    temp_paths: list[Path | str] | None = None,
    model_paths: list[Path | str] | None = None,
    cache_paths: list[Path | str] | None = None,
    docker_gpus: str | None = None,
    compose_file: Path = DEFAULT_BACKENDS_COMPOSE_FILE,
) -> BackendProcessSpec:
    """Build a process spec for a Python backend script."""

    runtime = resolve_backend_runtime(backend_id, runtime_override=runtime_override)
    extra_env = dict(extra_env or {})

    if runtime == "isolated":
        if isolated_python is None or setup_script is None:
            raise RuntimeError(
                f"{display_name} isolated runtime is not configured for this caller."
            )
        if not _check_isolated_python_available(isolated_python):
            raise RuntimeError(
                f"{display_name} environment not set up. Run: ./besedy/scripts/{setup_script}"
            )
        env_updates = {
            "PYTHONPATH": _prepend_env_path(str(PROJECT_ROOT), os.getenv("PYTHONPATH")),
            "BESEDY_CONFIG": str(resolve_config_path()),
        }
        env_updates.update(extra_env)
        return BackendProcessSpec(
            argv=(str(isolated_python), str(script_path), *script_args),
            extra_env=env_updates,
            runtime=runtime,
        )

    ok, message = _docker_runtime_ready(
        display_name=display_name,
        docker_service=docker_service,
        compose_file=compose_file,
    )
    if not ok:
        raise RuntimeError(message or f"{display_name} Docker runtime is unavailable.")
    _validate_docker_gpu_request(
        backend_id=backend_id,
        display_name=display_name,
        docker_gpus=docker_gpus,
    )

    cache_env, default_cache_paths = _default_cache_paths(backend_id)
    mounts = _build_docker_mounts(
        backend_id=backend_id,
        include_project_root=True,
        include_config=True,
        input_paths=input_paths or [],
        output_paths=output_paths or [],
        temp_paths=temp_paths or [],
        model_paths=model_paths or [],
        cache_paths=[*default_cache_paths, *(cache_paths or [])],
    )
    try:
        relative_script = _abspath_no_resolve(script_path).relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise RuntimeError(
            f"Python backend script must live under the project root: {script_path}"
        ) from exc
    container_script = DEFAULT_CONTAINER_PROJECT_ROOT / relative_script

    container_env = {
        "PYTHONPATH": str(DEFAULT_CONTAINER_PROJECT_ROOT),
        "BESEDY_CONFIG": str(DEFAULT_CONTAINER_CONFIG_PATH),
        **cache_env,
        **extra_env,
    }
    run_spec = DockerComposeRunSpec(
        compose_file=compose_file,
        service=docker_service or backend_id,
        argv=("python", str(container_script), *script_args),
        mounts=tuple(mounts),
        env=container_env,
        gpus=docker_gpus,
        workdir=DEFAULT_CONTAINER_PROJECT_ROOT,
        user=default_docker_user(),
    )
    return BackendProcessSpec(
        argv=tuple(build_compose_run_argv(run_spec)),
        extra_env=None,
        runtime=runtime,
    )


def build_command_backend_process(
    *,
    backend_id: str,
    display_name: str,
    host_argv: list[str] | None = None,
    docker_argv: list[str],
    docker_service: str | None = None,
    runtime_override: str | None = None,
    extra_env: dict[str, str] | None = None,
    input_paths: list[Path | str] | None = None,
    output_paths: list[Path | str] | None = None,
    temp_paths: list[Path | str] | None = None,
    model_paths: list[Path | str] | None = None,
    cache_paths: list[Path | str] | None = None,
    docker_gpus: str | None = None,
    include_project_root: bool = False,
    include_config: bool = False,
    compose_file: Path = DEFAULT_BACKENDS_COMPOSE_FILE,
) -> BackendProcessSpec:
    """Build a process spec for a backend CLI command."""

    runtime = resolve_backend_runtime(backend_id, runtime_override=runtime_override)
    extra_env = dict(extra_env or {})

    if runtime == "isolated":
        if host_argv is None:
            raise RuntimeError(
                f"{display_name} isolated runtime is not configured for this caller."
            )
        return BackendProcessSpec(
            argv=tuple(host_argv),
            extra_env=extra_env or None,
            runtime=runtime,
        )

    ok, message = _docker_runtime_ready(
        display_name=display_name,
        docker_service=docker_service,
        compose_file=compose_file,
    )
    if not ok:
        raise RuntimeError(message or f"{display_name} Docker runtime is unavailable.")
    _validate_docker_gpu_request(
        backend_id=backend_id,
        display_name=display_name,
        docker_gpus=docker_gpus,
    )

    cache_env, default_cache_paths = _default_cache_paths(backend_id)
    mounts = _build_docker_mounts(
        backend_id=backend_id,
        include_project_root=include_project_root,
        include_config=include_config,
        input_paths=input_paths or [],
        output_paths=output_paths or [],
        temp_paths=temp_paths or [],
        model_paths=model_paths or [],
        cache_paths=[*default_cache_paths, *(cache_paths or [])],
    )
    run_spec = DockerComposeRunSpec(
        compose_file=compose_file,
        service=docker_service or backend_id,
        argv=tuple(docker_argv),
        mounts=tuple(mounts),
        env={**cache_env, **extra_env},
        gpus=docker_gpus,
        user=default_docker_user(),
    )
    return BackendProcessSpec(
        argv=tuple(build_compose_run_argv(run_spec)),
        extra_env=None,
        runtime=runtime,
    )
