"""Main-environment facade for ColBERT sidecar indexing and querying."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

from besedy.core.paths import PROJECT_ROOT
from besedy.core.symlinks import create_or_update_symlink
from besedy.lib.rag_bundle import (
    colbert_bundle_metadata_error_message,
    resolve_colbert_bundle_artifacts,
    validate_colbert_bundle,
    write_colbert_active_pointer,
)
from besedy.lib.rag_chunk_corpus import (
    build_chunk_corpus,
    discover_transcript_sources,
)
from besedy.lib.rag_chunk_store import (
    ChunkNeighbors,
    count_chunks_by_audio_hash,
    delete_chunks_for_audio_hashes,
    list_chunk_ids_by_audio_hashes,
    list_chunks,
    replace_chunks_for_audio_hash,
    write_chunk_store,
)
from besedy.lib.rag_colbert_artifacts import (
    _build_bundle_fingerprint,
    _build_chunking_fingerprint,
    _build_source_state_rows,
    _coerce_index_result_from_meta,
    _coerce_rag_chunk,
    _coerce_token_audit,
    _index_target_paths,
    _read_chunk_manifest,
    _read_index_meta,
    _remove_existing_path,
    _write_chunk_manifest,
    _write_index_meta,
    _zero_token_audit,
    default_colbert_index_dir,
    validate_chunk_target_ids_against_manifest,
)
from besedy.lib.rag_colbert_runtime_config import (
    COLBERT_DOCKER_COMPOSE_FILE,
    COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR,
    COLBERT_DOCKER_INDEXER_PROFILE,
    COLBERT_DOCKER_INDEXER_RUN_COMMAND,
    COLBERT_DOCKER_INDEXER_SERVICE,
    COLBERT_DOCKER_INDEXER_TMPDIR,
    COLBERT_DOCKER_INDEXER_TORCH_EXTENSIONS_DIR,
    COLBERT_DOCKER_PROJECT_ROOT,
    COLBERT_DOCKER_QUERY_HOST,
    COLBERT_DOCKER_QUERY_PORT,
    COLBERT_DOCKER_SERVICE,
    COLBERT_DOCKER_UP_COMMAND,
    COLBERT_RUNTIME_CHOICES,
    COLBERT_RUNTIME_DOCKER,
    COLBERT_RUNTIME_DOCKER_INDEXER,
    COLBERT_RUNTIME_ENV_VAR,
    docker_runtime_supports_path,
    host_has_nvidia_gpu,
)
from besedy.lib.rag_colbert_runtime_config import (
    default_colbert_index_runtime as _default_colbert_index_runtime,
)
from besedy.lib.rag_colbert_runtime_config import (
    docker_bundle_payload_context as _docker_bundle_payload_context,
)
from besedy.lib.rag_colbert_runtime_config import (
    docker_worker_payload as _docker_worker_payload,
)
from besedy.lib.rag_colbert_runtime_config import (
    resolve_colbert_runtime as _resolve_colbert_runtime,
)
from besedy.lib.rag_colbert_source_state import (
    ColbertSourceStateRow,
    delete_source_state_rows,
    initialize_source_state,
    read_source_state,
    replace_source_state,
    upsert_source_state_rows,
)
from besedy.lib.rag_colbert_sync_support import (
    _build_chunks_for_source,
    _classify_sources,
    _colbert_scope_lock,
    _copy_bundle_to_staging,
    _cutover_staged_bundle,
    _resolve_sync_bundle_context,
    _rewrite_chunk_manifest_from_store,
    _source_state_requires_rebuild,
    _validate_bundle_artifacts_for_sync,
)
from besedy.lib.rag_colbert_types import (
    ColbertIndexResult,
    ColbertQueryHit,
    ColbertQueryResult,
    ColbertTokenAudit,
)
from besedy.lib.rag_pylate import (
    DEFAULT_PYLATE_PLAID_BACKEND,
    PYLATE_INDEX_FORMAT_VERSION,
    PYLATE_RETRIEVAL_ENGINE,
)
from besedy.lib.rag_retrieval_chunking import (
    CHUNK_VERSION,
    summarize_token_counts,
)
from besedy.lib.rag_retrieval_types import RagChunk
from besedy.lib.subprocess_utils import register_process, unregister_process

DEFAULT_COLBERT_MODEL = "jinaai/jina-colbert-v2"


def resolve_default_colbert_model() -> str:
    """Resolve the default ColBERT model.

    Precedence: RAG_COLBERT_MODEL env var > [rag].colbert_model in besedy.toml >
    the built-in DEFAULT_COLBERT_MODEL. Explicit CLI/API values still win, since
    callers pass them in directly.
    """
    env_value = os.getenv("RAG_COLBERT_MODEL", "").strip()
    if env_value:
        return env_value
    try:
        from besedy.config.settings import config

        toml_value = (getattr(config.rag, "colbert_model", "") or "").strip()
    except Exception:
        toml_value = ""
    return toml_value or DEFAULT_COLBERT_MODEL


DEFAULT_DOC_MAXLEN = 384
DEFAULT_INDEX_BSIZE = 32
DEFAULT_MIN_CHUNK_TOKENS = 180
DEFAULT_MAX_CHUNK_TOKENS = 260
DEFAULT_OVERLAP_TOKENS = 40
COLBERT_BUILD_PHASE_COUNT = 6
COLBERT_SYNC_LOCK_NAME = ".sync.lock"
COLBERT_DEFAULT_PLAID_BACKEND = DEFAULT_PYLATE_PLAID_BACKEND


def _format_elapsed(seconds: float) -> str:
    total_seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _emit_build_progress(
    progress_callback: Callable[[str], None] | None,
    message: str,
) -> None:
    if progress_callback is None:
        return
    progress_callback(message)


def _emit_phase_start(
    *,
    progress_callback: Callable[[str], None] | None,
    phase_index: int,
    label: str,
    total_started_at: float,
) -> float:
    _emit_build_progress(
        progress_callback,
        (
            f"Phase {phase_index}/{COLBERT_BUILD_PHASE_COUNT}: {label}... "
            f"| elapsed {_format_elapsed(time.perf_counter() - total_started_at)}"
        ),
    )
    return time.perf_counter()


def _emit_phase_complete(
    *,
    progress_callback: Callable[[str], None] | None,
    phase_index: int,
    phase_started_at: float,
    total_started_at: float,
    detail: str | None = None,
) -> None:
    message = (
        f"Phase {phase_index}/{COLBERT_BUILD_PHASE_COUNT} complete in "
        f"{_format_elapsed(time.perf_counter() - phase_started_at)}"
        f" | elapsed {_format_elapsed(time.perf_counter() - total_started_at)}"
    )
    if detail:
        message = f"{message} | {detail}"
    _emit_build_progress(progress_callback, message)


def _emit_phase_skipped(
    *,
    progress_callback: Callable[[str], None] | None,
    phase_index: int,
    label: str,
    total_started_at: float,
    reason: str,
) -> None:
    _emit_build_progress(
        progress_callback,
        (
            f"Phase {phase_index}/{COLBERT_BUILD_PHASE_COUNT}: {label} skipped "
            f"({reason}) | elapsed {_format_elapsed(time.perf_counter() - total_started_at)}"
        ),
    )


def default_colbert_index_runtime() -> str:
    """Return the preferred ColBERT indexing runtime for the current host."""

    return _default_colbert_index_runtime(has_nvidia_gpu=host_has_nvidia_gpu)


def check_colbert_runtime_ready(runtime_override: str | None = None) -> None:
    """Raise when the configured ColBERT runtime is unavailable for indexing."""

    runtime = _resolve_colbert_runtime(runtime_override)
    if runtime == COLBERT_RUNTIME_DOCKER:
        _check_colbert_docker_ready()
        return
    _check_colbert_docker_indexer_ready()


def _parse_json_dict_output(raw_output: str, *, error_prefix: str) -> dict[str, Any]:
    normalized_output = raw_output.strip()
    if not normalized_output:
        return {}

    decoder = json.JSONDecoder()
    last_error: json.JSONDecodeError | None = None
    for start, char in enumerate(normalized_output):
        if char not in "{[":
            continue
        try:
            parsed, end = decoder.raw_decode(normalized_output[start:])
        except json.JSONDecodeError as exc:
            last_error = exc
            continue
        if normalized_output[start + end :].strip():
            continue
        if not isinstance(parsed, dict):
            raise RuntimeError(f"{error_prefix} returned unexpected payload: {type(parsed)!r}")
        return parsed

    if last_error is not None:
        raise RuntimeError(
            f"{error_prefix} returned invalid JSON: {normalized_output}"
        ) from last_error
    raise RuntimeError(f"{error_prefix} returned invalid JSON: {normalized_output}")


def _run_colbert_worker_in_docker_one_shot(
    *,
    command: str,
    payload: dict[str, Any],
    volume_args: list[str] | None = None,
    live_output: bool = False,
    live_output_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    _check_colbert_docker_service_defined(COLBERT_DOCKER_SERVICE)
    argv = [
        "docker",
        "compose",
        "-f",
        str(COLBERT_DOCKER_COMPOSE_FILE),
        "run",
        "--rm",
        "--no-deps",
        "-T",
        *(volume_args or []),
        COLBERT_DOCKER_SERVICE,
        "env",
        f"PYTHONPATH={COLBERT_DOCKER_PROJECT_ROOT}",
        "python",
        "-m",
        "besedy.lib.rag_colbert_runtime.worker",
        command,
    ]
    if live_output:
        return _run_live_colbert_worker_process(
            argv=argv,
            payload_json=json.dumps(payload, ensure_ascii=False),
            cwd=PROJECT_ROOT,
            error_prefix="ColBERT Docker one-shot worker",
            progress_callback=live_output_callback,
        )

    result = subprocess.run(
        argv,
        input=json.dumps(payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=PROJECT_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = (
            result.stderr.strip()
            or result.stdout.strip()
            or "unknown ColBERT Docker one-shot worker error"
        )
        raise RuntimeError(f"ColBERT Docker one-shot worker failed: {message}")

    return _parse_json_dict_output(
        result.stdout,
        error_prefix="ColBERT Docker one-shot worker",
    )


def _check_colbert_docker_binary_ready() -> None:
    if shutil.which("docker") is None:
        raise RuntimeError(
            "Docker is not installed or not in PATH. Docker is required for all ColBERT runtimes."
        )


def _list_colbert_docker_services(*, include_indexer_profile: bool = False) -> set[str]:
    _check_colbert_docker_binary_ready()
    argv = ["docker", "compose", "-f", str(COLBERT_DOCKER_COMPOSE_FILE)]
    if include_indexer_profile:
        argv.extend(["--profile", COLBERT_DOCKER_INDEXER_PROFILE])
    argv.extend(["config", "--services"])
    result = subprocess.run(
        argv,
        text=True,
        capture_output=True,
        cwd=PROJECT_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "unknown docker compose error"
        raise RuntimeError(
            f"Unable to inspect the ColBERT Docker services. Docker error: {message}"
        )
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def _check_colbert_docker_service_defined(
    service_name: str,
    *,
    include_indexer_profile: bool = False,
) -> None:
    services = _list_colbert_docker_services(include_indexer_profile=include_indexer_profile)
    if service_name not in services:
        raise RuntimeError(
            f"ColBERT Docker service is not defined in {COLBERT_DOCKER_COMPOSE_FILE}: {service_name}"
        )


def _check_colbert_docker_ready() -> None:
    _check_colbert_docker_service_defined(COLBERT_DOCKER_SERVICE)

    result = subprocess.run(
        [
            "docker",
            "compose",
            "-f",
            str(COLBERT_DOCKER_COMPOSE_FILE),
            "ps",
            "--services",
            "--status",
            "running",
            COLBERT_DOCKER_SERVICE,
        ],
        text=True,
        capture_output=True,
        cwd=PROJECT_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "unknown docker compose error"
        raise RuntimeError(
            "Unable to inspect the ColBERT Docker service. "
            f"Start it with: {COLBERT_DOCKER_UP_COMMAND}. "
            f"Docker error: {message}"
        )
    running_services = {line.strip() for line in result.stdout.splitlines() if line.strip()}
    if COLBERT_DOCKER_SERVICE not in running_services:
        raise RuntimeError(
            f"ColBERT Docker service is not running. Start it with: {COLBERT_DOCKER_UP_COMMAND}"
        )


def _check_colbert_docker_indexer_ready() -> None:
    _check_colbert_docker_service_defined(
        COLBERT_DOCKER_INDEXER_SERVICE,
        include_indexer_profile=True,
    )


def _run_live_colbert_worker_process(
    *,
    argv: list[str],
    payload_json: str,
    cwd: Path,
    error_prefix: str,
    env: dict[str, str] | None = None,
    progress_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def _consume_stdout() -> None:
        if proc.stdout is None:
            return
        try:
            stdout_chunks.append(proc.stdout.read())
        finally:
            proc.stdout.close()

    def _consume_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            for line in proc.stderr:
                stderr_chunks.append(line)
                normalized = line.rstrip("\n")
                if progress_callback is not None:
                    progress_callback(normalized)
                else:
                    print(normalized, file=sys.stderr, flush=True)
        finally:
            proc.stderr.close()

    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=cwd,
        env=env,
    )
    register_process(proc)
    try:
        stdout_thread = threading.Thread(target=_consume_stdout)
        stderr_thread = threading.Thread(target=_consume_stderr)
        stdout_thread.start()
        stderr_thread.start()
        try:
            if proc.stdin is not None:
                try:
                    proc.stdin.write(payload_json)
                except BrokenPipeError:
                    pass
                finally:
                    proc.stdin.close()
            proc.wait()
        finally:
            stdout_thread.join()
            stderr_thread.join()
    finally:
        unregister_process(proc)

    if proc.returncode != 0:
        detail = "".join(stderr_chunks).strip() or "".join(stdout_chunks).strip()
        if detail:
            raise RuntimeError(f"{error_prefix} failed with exit code {proc.returncode}: {detail}")
        raise RuntimeError(f"{error_prefix} failed with exit code {proc.returncode}.")

    return _parse_json_dict_output("".join(stdout_chunks), error_prefix=error_prefix)


def _run_colbert_worker_in_docker(
    *,
    command: str,
    payload: dict[str, Any],
    live_output: bool = False,
    live_output_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if command in {"query-index", "lookup-chunks", "lookup-neighbors"}:
        docker_payload, volume_args, _docker_bundle_dir = _docker_bundle_payload_context(payload)
        if volume_args:
            return _run_colbert_worker_in_docker_one_shot(
                command=command,
                payload=docker_payload,
                volume_args=volume_args,
                live_output=live_output,
                live_output_callback=live_output_callback,
            )
        _check_colbert_docker_ready()
        _check_colbert_docker_query_service_ready()
        if command == "query-index":
            return _run_colbert_query_in_docker_service(payload=payload)
        if command == "lookup-chunks":
            return _run_colbert_lookup_in_docker_service(payload=payload)
        return _run_colbert_neighbors_in_docker_service(payload=payload)

    if command in {"add-to-index", "delete-from-index"}:
        docker_payload, volume_args, _docker_bundle_dir = _docker_bundle_payload_context(payload)
        return _run_colbert_worker_in_docker_one_shot(
            command=command,
            payload=docker_payload,
            volume_args=volume_args,
            live_output=live_output,
            live_output_callback=live_output_callback,
        )

    _check_colbert_docker_ready()
    docker_payload = _docker_worker_payload(payload)
    argv = [
        "docker",
        "compose",
        "-f",
        str(COLBERT_DOCKER_COMPOSE_FILE),
        "exec",
        "-T",
        COLBERT_DOCKER_SERVICE,
        "env",
        f"PYTHONPATH={COLBERT_DOCKER_PROJECT_ROOT}",
        "python",
        "-m",
        "besedy.lib.rag_colbert_runtime.worker",
        command,
    ]
    if live_output:
        return _run_live_colbert_worker_process(
            argv=argv,
            payload_json=json.dumps(docker_payload, ensure_ascii=False),
            cwd=PROJECT_ROOT,
            error_prefix="ColBERT Docker worker",
            progress_callback=live_output_callback,
        )

    result = subprocess.run(
        argv,
        input=json.dumps(docker_payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=PROJECT_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "unknown ColBERT worker error"
        raise RuntimeError(f"ColBERT Docker worker failed: {message}")

    return _parse_json_dict_output(result.stdout, error_prefix="ColBERT Docker worker")


def _docker_indexer_env_args(*, docker_bundle_dir: str | None = None) -> list[str]:
    args: list[str] = [
        "-e",
        f"TMPDIR={COLBERT_DOCKER_INDEXER_TMPDIR}",
        "-e",
        f"TMP={COLBERT_DOCKER_INDEXER_TMPDIR}",
        "-e",
        f"TEMP={COLBERT_DOCKER_INDEXER_TMPDIR}",
        "-e",
        f"TORCH_EXTENSIONS_DIR={COLBERT_DOCKER_INDEXER_TORCH_EXTENSIONS_DIR}",
    ]
    if docker_bundle_dir is not None:
        host_uid = getattr(os, "getuid", lambda: None)()
        host_gid = getattr(os, "getgid", lambda: None)()
        args.extend(["-e", f"BESEDY_COLBERT_BUNDLE_DIR={docker_bundle_dir}"])
        if host_uid is not None:
            args.extend(["-e", f"BESEDY_COLBERT_CHOWN_UID={host_uid}"])
        if host_gid is not None:
            args.extend(["-e", f"BESEDY_COLBERT_CHOWN_GID={host_gid}"])
    return args


def _run_colbert_worker_in_docker_indexer(
    *,
    command: str,
    payload: dict[str, Any],
    live_output: bool = False,
    live_output_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    if command not in {"audit-tokens", "build-index", "add-to-index", "delete-from-index"}:
        raise RuntimeError(
            "The ColBERT Docker indexer runtime only supports audit-tokens, build-index, "
            "add-to-index, and delete-from-index."
        )

    _check_colbert_docker_indexer_ready()
    if command == "audit-tokens":
        docker_payload = dict(payload)
        volume_args: list[str] = []
        docker_env_args = _docker_indexer_env_args()
    else:
        docker_payload, volume_args, docker_bundle_dir = _docker_bundle_payload_context(payload)
        docker_env_args = _docker_indexer_env_args(docker_bundle_dir=docker_bundle_dir)
    argv = [
        "docker",
        "compose",
        "-f",
        str(COLBERT_DOCKER_COMPOSE_FILE),
        "--profile",
        COLBERT_DOCKER_INDEXER_PROFILE,
        "run",
        "--rm",
        "--no-deps",
        "-T",
        *volume_args,
        *docker_env_args,
        COLBERT_DOCKER_INDEXER_SERVICE,
        command,
    ]
    if live_output:
        return _run_live_colbert_worker_process(
            argv=argv,
            payload_json=json.dumps(docker_payload, ensure_ascii=False),
            cwd=PROJECT_ROOT,
            error_prefix="ColBERT Docker indexer",
            progress_callback=live_output_callback,
        )

    result = subprocess.run(
        argv,
        input=json.dumps(docker_payload, ensure_ascii=False),
        text=True,
        capture_output=True,
        cwd=PROJECT_ROOT,
        check=False,
    )
    if result.returncode != 0:
        message = (
            result.stderr.strip() or result.stdout.strip() or "unknown ColBERT Docker indexer error"
        )
        raise RuntimeError(f"ColBERT Docker indexer failed: {message}")

    return _parse_json_dict_output(result.stdout, error_prefix="ColBERT Docker indexer")


def _colbert_docker_query_url(path: str) -> str:
    normalized_path = path if path.startswith("/") else f"/{path}"
    return f"http://{COLBERT_DOCKER_QUERY_HOST}:{COLBERT_DOCKER_QUERY_PORT}{normalized_path}"


def _http_json_request(
    *,
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    encoded_payload = None
    headers: dict[str, str] = {}
    if payload is not None:
        encoded_payload = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        data=encoded_payload,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw_response = response.read().decode("utf-8").strip()
    if not raw_response:
        return {}
    try:
        parsed = json.loads(raw_response)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ColBERT Docker service returned invalid JSON: {raw_response}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"ColBERT Docker service returned unexpected payload: {type(parsed)!r}")
    return parsed


def _check_colbert_docker_query_service_ready() -> None:
    try:
        _http_json_request(
            method="GET",
            url=_colbert_docker_query_url("/health"),
            timeout=5.0,
        )
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "ColBERT Docker query service is not ready. "
            f"Restart it with: {COLBERT_DOCKER_UP_COMMAND}"
        ) from exc


def _run_colbert_query_in_docker_service(*, payload: dict[str, Any]) -> dict[str, Any]:
    return _run_colbert_service_request_in_docker(path="/query", payload=payload)


def _run_colbert_lookup_in_docker_service(*, payload: dict[str, Any]) -> dict[str, Any]:
    return _run_colbert_service_request_in_docker(path="/lookup", payload=payload)


def _run_colbert_neighbors_in_docker_service(*, payload: dict[str, Any]) -> dict[str, Any]:
    return _run_colbert_service_request_in_docker(path="/neighbors", payload=payload)


def _run_colbert_service_request_in_docker(*, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    docker_payload = _docker_worker_payload(payload)
    try:
        return _http_json_request(
            method="POST",
            url=_colbert_docker_query_url(path),
            payload=docker_payload,
            timeout=120.0,
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace").strip()
        message = detail or str(exc)
        raise RuntimeError(f"ColBERT Docker query service failed: {message}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "ColBERT Docker query service is unreachable. "
            f"Restart it with: {COLBERT_DOCKER_UP_COMMAND}"
        ) from exc


def _run_colbert_worker(
    *,
    command: str,
    payload: dict[str, Any],
    runtime_override: str | None = None,
    live_output: bool = False,
    live_output_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    runtime = _resolve_colbert_runtime(runtime_override)
    if runtime == COLBERT_RUNTIME_DOCKER:
        return _run_colbert_worker_in_docker(
            command=command,
            payload=payload,
            live_output=live_output,
            live_output_callback=live_output_callback,
        )
    if runtime == COLBERT_RUNTIME_DOCKER_INDEXER:
        if command in {"audit-tokens", "build-index", "add-to-index", "delete-from-index"}:
            return _run_colbert_worker_in_docker_indexer(
                command=command,
                payload=payload,
                live_output=live_output,
                live_output_callback=live_output_callback,
            )
        return _run_colbert_worker_in_docker(
            command=command,
            payload=payload,
            live_output=live_output,
            live_output_callback=live_output_callback,
        )
    raise AssertionError(f"Unexpected ColBERT runtime after normalization: {runtime}")


def _emit_sync_progress(
    progress_callback: Callable[[str], None] | None,
    message: str,
) -> None:
    _emit_build_progress(progress_callback, message)


def audit_colbert_token_lengths(
    *,
    texts: list[str],
    colbert_model: str,
    doc_maxlen: int,
    runtime: str | None = None,
) -> ColbertTokenAudit:
    if not texts:
        return _zero_token_audit(colbert_model=colbert_model, doc_maxlen=doc_maxlen)

    worker_kwargs: dict[str, Any] = {
        "command": "audit-tokens",
        "payload": {
            "texts": texts,
            "colbert_model": colbert_model,
            "doc_maxlen": doc_maxlen,
        },
    }
    if runtime is not None:
        worker_kwargs["runtime_override"] = runtime
    payload = _run_colbert_worker(**worker_kwargs)
    return _coerce_token_audit(payload, colbert_model=colbert_model, doc_maxlen=doc_maxlen)


def build_colbert_index(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path | str | None = None,
    index_dir: Path | str | None = None,
    colbert_model: str = DEFAULT_COLBERT_MODEL,
    doc_maxlen: int = DEFAULT_DOC_MAXLEN,
    index_bsize: int = DEFAULT_INDEX_BSIZE,
    use_faiss: bool = False,
    overwrite: bool = False,
    min_chunk_tokens: int = DEFAULT_MIN_CHUNK_TOKENS,
    max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    chunk_tokenizer_model: str | None = None,
    runtime: str | None = None,
    progress_callback: Callable[[str], None] | None = None,
) -> ColbertIndexResult:
    """Build the ColBERT sidecar index for one transcript backend scope."""

    if index_bsize <= 0:
        raise ValueError("index_bsize must be positive.")
    effective_chunk_tokenizer_model = (
        chunk_tokenizer_model.strip()
        if chunk_tokenizer_model and chunk_tokenizer_model.strip()
        else colbert_model
    )
    total_started_at = time.perf_counter()
    phase_started_at = _emit_phase_start(
        progress_callback=progress_callback,
        phase_index=1,
        label="building chunk corpus",
        total_started_at=total_started_at,
    )
    corpus = build_chunk_corpus(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        transcripts_root=transcripts_root,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
    )
    _emit_phase_complete(
        progress_callback=progress_callback,
        phase_index=1,
        phase_started_at=phase_started_at,
        total_started_at=total_started_at,
        detail=(
            f"transcript_files={corpus.transcript_files} | "
            f"chunk_count={len(corpus.chunks)} | skipped={corpus.transcripts_skipped} | "
            f"chunk_tokenizer_model={effective_chunk_tokenizer_model}"
        ),
    )

    chunking_fingerprint = _build_chunking_fingerprint(
        chunk_version=corpus.chunk_version,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
    )
    bundle_fingerprint = _build_bundle_fingerprint(
        colbert_model=colbert_model,
        doc_maxlen=doc_maxlen,
        index_bsize=index_bsize,
        plaid_backend=COLBERT_DEFAULT_PLAID_BACKEND,
    )
    source_build = discover_transcript_sources(
        workflow_group_id=workflow_group_id,
        backend_key=corpus.backend_key,
        transcripts_root=corpus.transcripts_root,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
    )

    target_dir, exposed_index_dir, symlink_path = _index_target_paths(
        requested_index_dir=Path(index_dir) if index_dir is not None else None,
        workflow_group_id=workflow_group_id,
        backend_key=corpus.backend_key,
        chunk_version=corpus.chunk_version,
        colbert_model=colbert_model,
        overwrite=overwrite,
    )
    target_dir.mkdir(parents=True, exist_ok=False)

    phase_started_at = _emit_phase_start(
        progress_callback=progress_callback,
        phase_index=2,
        label="writing chunk manifest",
        total_started_at=total_started_at,
    )
    _write_chunk_manifest(target_dir=target_dir, chunks=corpus.chunks)
    _emit_phase_complete(
        progress_callback=progress_callback,
        phase_index=2,
        phase_started_at=phase_started_at,
        total_started_at=total_started_at,
        detail=f"manifest_path={resolve_colbert_bundle_artifacts(target_dir).chunk_manifest_path}",
    )

    phase_started_at = _emit_phase_start(
        progress_callback=progress_callback,
        phase_index=3,
        label="writing chunk store",
        total_started_at=total_started_at,
    )
    write_chunk_store(
        path=resolve_colbert_bundle_artifacts(target_dir).chunk_store_path,
        chunks=corpus.chunks,
    )
    _emit_phase_complete(
        progress_callback=progress_callback,
        phase_index=3,
        phase_started_at=phase_started_at,
        total_started_at=total_started_at,
        detail=f"chunk_store_path={resolve_colbert_bundle_artifacts(target_dir).chunk_store_path}",
    )

    if corpus.chunks:
        bundle_artifacts = resolve_colbert_bundle_artifacts(target_dir)
        worker_kwargs: dict[str, Any] = {
            "command": "build-index",
            "payload": {
                "manifest_path": str(bundle_artifacts.chunk_manifest_path),
                "colbert_index_dir": str(bundle_artifacts.colbert_index_dir),
                "colbert_model": colbert_model,
                "doc_maxlen": doc_maxlen,
                "index_bsize": index_bsize,
                "use_faiss": use_faiss,
                "plaid_backend": COLBERT_DEFAULT_PLAID_BACKEND,
            },
        }
        if runtime is not None:
            worker_kwargs["runtime_override"] = runtime
        if progress_callback is not None:
            worker_kwargs["live_output"] = True
            worker_kwargs["live_output_callback"] = progress_callback
        worker_payload = _run_colbert_worker(**worker_kwargs)
        token_audit = _coerce_token_audit(
            worker_payload.get("token_audit", {}),
            colbert_model=colbert_model,
            doc_maxlen=doc_maxlen,
        )
        retrieval_engine_version = str(worker_payload.get("retrieval_engine_version", "unknown"))
    else:
        _emit_phase_skipped(
            progress_callback=progress_callback,
            phase_index=4,
            label="auditing token lengths",
            total_started_at=total_started_at,
            reason="empty corpus",
        )
        _emit_phase_skipped(
            progress_callback=progress_callback,
            phase_index=5,
            label="indexing with ColBERT",
            total_started_at=total_started_at,
            reason="empty corpus",
        )
        token_audit = _zero_token_audit(colbert_model=colbert_model, doc_maxlen=doc_maxlen)
        retrieval_engine_version = "unknown"

    phase_started_at = _emit_phase_start(
        progress_callback=progress_callback,
        phase_index=6,
        label="finalizing bundle metadata and pointers",
        total_started_at=total_started_at,
    )
    _write_index_meta(
        target_dir=target_dir,
        workflow_group_id=workflow_group_id,
        backend_key=corpus.backend_key,
        run_id=corpus.run_id,
        chunk_version=corpus.chunk_version,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
        transcripts_root=corpus.transcripts_root,
        colbert_model=colbert_model,
        doc_maxlen=doc_maxlen,
        index_bsize=index_bsize,
        use_faiss=use_faiss,
        retrieval_engine_version=retrieval_engine_version,
        plaid_backend=COLBERT_DEFAULT_PLAID_BACKEND,
        chunk_count=len(corpus.chunks),
        token_audit=token_audit,
        chunk_distribution=corpus.chunk_distribution,
        chunking_fingerprint=chunking_fingerprint,
        bundle_fingerprint=bundle_fingerprint,
    )
    replace_source_state(
        path=resolve_colbert_bundle_artifacts(target_dir).source_state_path,
        rows=_build_source_state_rows(
            sources=source_build.sources,
            chunk_counts_by_hash=count_chunks_by_audio_hash(
                path=resolve_colbert_bundle_artifacts(target_dir).chunk_store_path,
            ),
            chunking_fingerprint=chunking_fingerprint,
            bundle_fingerprint=bundle_fingerprint,
            run_id=corpus.run_id,
        ),
    )

    if symlink_path is not None:
        create_or_update_symlink(symlink_path, target_dir, description="ColBERT index")
        write_colbert_active_pointer(
            workflow_group_id=workflow_group_id,
            backend_key=corpus.backend_key,
            colbert_model=colbert_model,
            chunk_version=corpus.chunk_version,
            index_dir=exposed_index_dir,
        )
    _emit_phase_complete(
        progress_callback=progress_callback,
        phase_index=6,
        phase_started_at=phase_started_at,
        total_started_at=total_started_at,
        detail=f"index_dir={exposed_index_dir}",
    )

    return ColbertIndexResult(
        index_dir=str(exposed_index_dir),
        workflow_group_id=workflow_group_id,
        backend_key=corpus.backend_key,
        run_id=corpus.run_id,
        chunk_version=corpus.chunk_version,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        colbert_model=colbert_model,
        doc_maxlen=doc_maxlen,
        index_bsize=index_bsize,
        split_documents=False,
        use_faiss=use_faiss,
        chunk_count=len(corpus.chunks),
        token_audit=token_audit,
        retrieval_engine=PYLATE_RETRIEVAL_ENGINE,
        retrieval_engine_version=retrieval_engine_version,
        index_format_version=PYLATE_INDEX_FORMAT_VERSION,
        plaid_backend=COLBERT_DEFAULT_PLAID_BACKEND,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
        chunking_fingerprint=chunking_fingerprint,
        bundle_fingerprint=bundle_fingerprint,
    )


def sync_colbert_index(
    *,
    workflow_group_id: str,
    backend_key: str,
    transcripts_root: Path | str | None = None,
    index_dir: Path | str | None = None,
    colbert_model: str = DEFAULT_COLBERT_MODEL,
    doc_maxlen: int = DEFAULT_DOC_MAXLEN,
    index_bsize: int = DEFAULT_INDEX_BSIZE,
    use_faiss: bool = False,
    force: bool = False,
    rebuild: bool = False,
    target_audio_hash: str | None = None,
    min_chunk_tokens: int = DEFAULT_MIN_CHUNK_TOKENS,
    max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
    chunk_tokenizer_model: str | None = None,
    runtime: str | None = None,
    progress_callback: Callable[[str], None] | None = None,
) -> ColbertIndexResult:
    """Incrementally sync the ColBERT sidecar bundle for one transcript backend scope."""

    if index_bsize <= 0:
        raise ValueError("index_bsize must be positive.")
    normalized_target_audio_hash = target_audio_hash.strip().lower() if target_audio_hash else None
    effective_chunk_tokenizer_model = (
        chunk_tokenizer_model.strip()
        if chunk_tokenizer_model and chunk_tokenizer_model.strip()
        else colbert_model
    )

    source_build = discover_transcript_sources(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        transcripts_root=transcripts_root,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
    )
    current_sources = {source.audio_hash: source for source in source_build.sources}
    discovered_count = 1 if normalized_target_audio_hash is not None else len(current_sources)
    chunking_fingerprint = _build_chunking_fingerprint(
        chunk_version=CHUNK_VERSION,
        min_chunk_tokens=min_chunk_tokens,
        max_chunk_tokens=max_chunk_tokens,
        overlap_tokens=overlap_tokens,
        chunk_tokenizer_model=effective_chunk_tokenizer_model,
    )
    bundle_fingerprint = _build_bundle_fingerprint(
        colbert_model=colbert_model,
        doc_maxlen=doc_maxlen,
        index_bsize=index_bsize,
        plaid_backend=COLBERT_DEFAULT_PLAID_BACKEND,
    )
    exposed_index_dir, existing_bundle_dir, staging_dir = _resolve_sync_bundle_context(
        workflow_group_id=workflow_group_id,
        backend_key=backend_key,
        colbert_model=colbert_model,
        chunk_version=CHUNK_VERSION,
        index_dir=index_dir,
    )
    explicit_index_dir = index_dir is not None
    lock_path = exposed_index_dir.parent / COLBERT_SYNC_LOCK_NAME

    if (
        normalized_target_audio_hash is not None
        and normalized_target_audio_hash not in current_sources
    ):
        raise FileNotFoundError(
            f"Requested audio hash is not present in the current transcript scope: {normalized_target_audio_hash}"
        )

    with _colbert_scope_lock(lock_path):

        def _full_rebuild(sync_mode: str, *, reason: str) -> ColbertIndexResult:
            _emit_sync_progress(
                progress_callback, f"ColBERT sync falling back to full rebuild: {reason}"
            )
            full_result = build_colbert_index(
                workflow_group_id=workflow_group_id,
                backend_key=backend_key,
                transcripts_root=source_build.transcripts_root,
                index_dir=index_dir,
                colbert_model=colbert_model,
                doc_maxlen=doc_maxlen,
                index_bsize=index_bsize,
                use_faiss=use_faiss,
                overwrite=explicit_index_dir,
                min_chunk_tokens=min_chunk_tokens,
                max_chunk_tokens=max_chunk_tokens,
                overlap_tokens=overlap_tokens,
                chunk_tokenizer_model=effective_chunk_tokenizer_model,
                runtime=runtime,
                progress_callback=progress_callback,
            )
            previous_rows = (
                read_source_state(
                    resolve_colbert_bundle_artifacts(existing_bundle_dir).source_state_path
                )
                if existing_bundle_dir is not None
                else {}
            )
            removed_hashes = 0
            if sync_mode == "bootstrap":
                added_hashes = len(current_sources)
                updated_hashes = 0
            else:
                added_hashes = sum(
                    1 for audio_hash in current_sources if audio_hash not in previous_rows
                )
                updated_hashes = len(current_sources) - added_hashes
                removed_hashes = sum(
                    1 for audio_hash in previous_rows if audio_hash not in current_sources
                )
            return replace(
                full_result,
                sync_mode=sync_mode,
                target_audio_hash=normalized_target_audio_hash,
                hashes_discovered=len(current_sources),
                hashes_added=added_hashes,
                hashes_updated=updated_hashes,
                hashes_removed=removed_hashes,
                chunks_inserted=full_result.chunk_count,
                chunks_deleted=0,
            )

        if rebuild:
            return _full_rebuild("rebuild", reason="requested by --rebuild")
        if existing_bundle_dir is None:
            return _full_rebuild("bootstrap", reason="no existing ColBERT bundle for this scope")

        try:
            active_meta = _read_index_meta(existing_bundle_dir)
        except FileNotFoundError:
            return _full_rebuild("rebuild", reason="existing bundle metadata is incomplete")
        compatibility_error = colbert_bundle_metadata_error_message(
            index_meta_path=resolve_colbert_bundle_artifacts(existing_bundle_dir).index_meta_path,
            payload=active_meta,
        )
        if compatibility_error is not None:
            return _full_rebuild("rebuild", reason=compatibility_error)
        if str(active_meta.get("chunk_version")) != CHUNK_VERSION:
            return _full_rebuild(
                "rebuild",
                reason=(
                    "active bundle chunk_version "
                    f"{active_meta.get('chunk_version')!r} does not match {CHUNK_VERSION!r}"
                ),
            )
        if str(active_meta.get("chunking_fingerprint", "")) != chunking_fingerprint:
            return _full_rebuild("rebuild", reason="chunking fingerprint changed")
        if str(active_meta.get("bundle_fingerprint", "")) != bundle_fingerprint:
            return _full_rebuild("rebuild", reason="bundle fingerprint changed")

        previous_rows = read_source_state(
            resolve_colbert_bundle_artifacts(existing_bundle_dir).source_state_path
        )
        if not previous_rows:
            return _full_rebuild("rebuild", reason="bundle-local source state is missing")
        if _source_state_requires_rebuild(
            previous_rows=previous_rows,
            chunking_fingerprint=chunking_fingerprint,
            bundle_fingerprint=bundle_fingerprint,
        ):
            return _full_rebuild(
                "rebuild", reason="bundle-local source state is inconsistent with current settings"
            )
        if int(active_meta.get("chunk_count", 0)) == 0 and current_sources:
            return _full_rebuild(
                "rebuild", reason="active bundle is empty but transcripts are present"
            )

        classification = _classify_sources(
            current_sources=current_sources,
            previous_rows=previous_rows,
            force=force,
            target_audio_hash=normalized_target_audio_hash,
        )
        if not classification.added and not classification.updated and not classification.removed:
            return _coerce_index_result_from_meta(
                index_dir=exposed_index_dir,
                meta=active_meta,
                sync_mode="forced" if force else "incremental",
                default_colbert_model=DEFAULT_COLBERT_MODEL,
                default_doc_maxlen=DEFAULT_DOC_MAXLEN,
                default_index_bsize=DEFAULT_INDEX_BSIZE,
                target_audio_hash=normalized_target_audio_hash,
                hashes_discovered=discovered_count,
                hashes_unchanged=len(classification.unchanged),
            )

        _emit_sync_progress(
            progress_callback,
            (
                "ColBERT incremental sync: "
                f"added={len(classification.added)} "
                f"updated={len(classification.updated)} "
                f"removed={len(classification.removed)} "
                f"unchanged={len(classification.unchanged)}"
            ),
        )

        cutover_complete = False
        chunks_deleted = 0
        chunks_inserted = 0
        try:
            _copy_bundle_to_staging(
                source_bundle_dir=existing_bundle_dir, staging_bundle_dir=staging_dir
            )
            stage_artifacts = resolve_colbert_bundle_artifacts(staging_dir)
            initialize_source_state(stage_artifacts.source_state_path)

            removed_audio_hashes = [row.audio_hash for row in classification.removed]
            if removed_audio_hashes:
                _emit_sync_progress(
                    progress_callback,
                    f"Removing {len(removed_audio_hashes)} audio hash(es) from staged ColBERT bundle...",
                )
                chunk_ids_by_hash = list_chunk_ids_by_audio_hashes(
                    path=stage_artifacts.chunk_store_path,
                    audio_hashes=removed_audio_hashes,
                )
                chunk_ids_to_delete = [
                    chunk_id
                    for audio_hash in removed_audio_hashes
                    for chunk_id in chunk_ids_by_hash.get(audio_hash, [])
                ]
                if chunk_ids_to_delete:
                    _run_colbert_worker(
                        command="delete-from-index",
                        payload={
                            "colbert_index_dir": str(stage_artifacts.colbert_index_dir),
                            "chunk_ids": chunk_ids_to_delete,
                        },
                        runtime_override=runtime,
                    )
                chunks_deleted += delete_chunks_for_audio_hashes(
                    path=stage_artifacts.chunk_store_path,
                    audio_hashes=removed_audio_hashes,
                )
                delete_source_state_rows(
                    path=stage_artifacts.source_state_path,
                    audio_hashes=removed_audio_hashes,
                )

            for delta in [*classification.updated, *classification.added]:
                _emit_sync_progress(
                    progress_callback,
                    f"Refreshing audio hash in staged ColBERT bundle: {delta.source.audio_hash}",
                )
                existing_chunk_ids = list_chunk_ids_by_audio_hashes(
                    path=stage_artifacts.chunk_store_path,
                    audio_hashes=[delta.source.audio_hash],
                ).get(delta.source.audio_hash, [])
                if existing_chunk_ids:
                    _run_colbert_worker(
                        command="delete-from-index",
                        payload={
                            "colbert_index_dir": str(stage_artifacts.colbert_index_dir),
                            "chunk_ids": existing_chunk_ids,
                        },
                        runtime_override=runtime,
                    )

                new_chunks = _build_chunks_for_source(
                    source=delta.source,
                    transcripts_root=Path(source_build.transcripts_root),
                    workflow_group_id=workflow_group_id,
                    backend_key=source_build.backend_key,
                    run_id=source_build.run_id,
                    min_chunk_tokens=min_chunk_tokens,
                    max_chunk_tokens=max_chunk_tokens,
                    overlap_tokens=overlap_tokens,
                    chunk_tokenizer_model=effective_chunk_tokenizer_model,
                )
                if new_chunks:
                    _run_colbert_worker(
                        command="add-to-index",
                        payload={
                            "colbert_index_dir": str(stage_artifacts.colbert_index_dir),
                            "rows": [
                                {
                                    "chunk_id": chunk.chunk_id,
                                    "audio_hash": chunk.audio_hash,
                                    "start_sec": chunk.start,
                                    "end_sec": chunk.end,
                                    "text": chunk.text,
                                    "run_id": chunk.run_id,
                                    "backend_key": chunk.backend_key,
                                    "chunk_version": chunk.chunk_version,
                                    "source_path": chunk.source_path,
                                    "token_count": chunk.token_count,
                                    "chunk_ordinal": chunk.chunk_ordinal,
                                }
                                for chunk in new_chunks
                            ],
                            "index_bsize": index_bsize,
                            "use_faiss": use_faiss,
                        },
                        runtime_override=runtime,
                    )

                deleted_count, inserted_count = replace_chunks_for_audio_hash(
                    path=stage_artifacts.chunk_store_path,
                    audio_hash=delta.source.audio_hash,
                    chunks=new_chunks,
                )
                chunks_deleted += deleted_count
                chunks_inserted += inserted_count
                upsert_source_state_rows(
                    path=stage_artifacts.source_state_path,
                    rows=[
                        ColbertSourceStateRow(
                            audio_hash=delta.source.audio_hash,
                            transcript_path=delta.source.transcript_path,
                            transcript_fingerprint=delta.source.transcript_fingerprint,
                            chunking_fingerprint=chunking_fingerprint,
                            bundle_fingerprint=bundle_fingerprint,
                            chunk_count=len(new_chunks),
                            last_run_id=source_build.run_id,
                        )
                    ],
                )

            _rewrite_chunk_manifest_from_store(bundle_dir=staging_dir)
            staged_chunks = list_chunks(path=stage_artifacts.chunk_store_path)
            if staged_chunks:
                token_audit = audit_colbert_token_lengths(
                    texts=[chunk.text for chunk in staged_chunks],
                    colbert_model=colbert_model,
                    doc_maxlen=doc_maxlen,
                    runtime=runtime,
                )
            else:
                token_audit = _zero_token_audit(colbert_model=colbert_model, doc_maxlen=doc_maxlen)
            chunk_distribution = summarize_token_counts(
                [chunk.token_count for chunk in staged_chunks],
                tokenizer_model=effective_chunk_tokenizer_model,
                min_tokens=min_chunk_tokens,
                max_tokens=max_chunk_tokens,
            )
            retrieval_engine_version = str(active_meta.get("retrieval_engine_version", "unknown"))
            _write_index_meta(
                target_dir=staging_dir,
                workflow_group_id=workflow_group_id,
                backend_key=source_build.backend_key,
                run_id=source_build.run_id,
                chunk_version=CHUNK_VERSION,
                min_chunk_tokens=min_chunk_tokens,
                max_chunk_tokens=max_chunk_tokens,
                overlap_tokens=overlap_tokens,
                chunk_tokenizer_model=effective_chunk_tokenizer_model,
                transcripts_root=source_build.transcripts_root,
                colbert_model=colbert_model,
                doc_maxlen=doc_maxlen,
                index_bsize=index_bsize,
                use_faiss=use_faiss,
                retrieval_engine_version=retrieval_engine_version,
                plaid_backend=COLBERT_DEFAULT_PLAID_BACKEND,
                chunk_count=len(staged_chunks),
                token_audit=token_audit,
                chunk_distribution=chunk_distribution,
                chunking_fingerprint=chunking_fingerprint,
                bundle_fingerprint=bundle_fingerprint,
            )
            _validate_bundle_artifacts_for_sync(bundle_dir=staging_dir)
            _cutover_staged_bundle(
                exposed_index_dir=exposed_index_dir,
                staging_dir=staging_dir,
                workflow_group_id=workflow_group_id,
                backend_key=source_build.backend_key,
                colbert_model=colbert_model,
                chunk_version=CHUNK_VERSION,
                explicit_index_dir=explicit_index_dir,
            )
            cutover_complete = True
            result_meta = _read_index_meta(exposed_index_dir)
            return _coerce_index_result_from_meta(
                index_dir=exposed_index_dir,
                meta=result_meta,
                sync_mode="forced" if force else "incremental",
                default_colbert_model=DEFAULT_COLBERT_MODEL,
                default_doc_maxlen=DEFAULT_DOC_MAXLEN,
                default_index_bsize=DEFAULT_INDEX_BSIZE,
                target_audio_hash=normalized_target_audio_hash,
                hashes_discovered=discovered_count,
                hashes_added=len(classification.added),
                hashes_updated=len(classification.updated),
                hashes_removed=len(classification.removed),
                hashes_unchanged=len(classification.unchanged),
                chunks_inserted=chunks_inserted,
                chunks_deleted=chunks_deleted,
            )
        finally:
            if not cutover_complete and staging_dir.exists():
                _remove_existing_path(staging_dir)


def query_colbert_index(
    *,
    query: str,
    index_dir: Path | str,
    k: int = 10,
    force_fast: bool = False,
) -> ColbertQueryResult:
    """Query the ColBERT sidecar index from the main environment."""

    if not query.strip():
        raise ValueError("Query must not be empty.")
    if k <= 0:
        raise ValueError("k must be positive.")

    resolved_index_dir = Path(index_dir)
    validate_colbert_bundle(resolved_index_dir)
    meta = _read_index_meta(resolved_index_dir)
    manifest_rows = _read_chunk_manifest(resolved_index_dir)
    if int(meta.get("chunk_count", 0)) == 0:
        return ColbertQueryResult(
            query=query,
            index_dir=str(resolved_index_dir),
            workflow_group_id=str(meta["workflow_group_id"]),
            backend_key=str(meta["backend_key"]),
            run_id=str(meta["run_id"]),
            chunk_version=str(meta["chunk_version"]),
            min_chunk_tokens=int(meta["min_chunk_tokens"])
            if meta.get("min_chunk_tokens") is not None
            else None,
            max_chunk_tokens=int(meta["max_chunk_tokens"])
            if meta.get("max_chunk_tokens") is not None
            else None,
            overlap_tokens=int(meta["overlap_tokens"])
            if meta.get("overlap_tokens") is not None
            else None,
            colbert_model=str(meta["colbert_model"]),
            doc_maxlen=int(meta["doc_maxlen"]),
            hits=[],
        )
    worker_payload = _run_colbert_worker(
        command="query-index",
        payload={
            "colbert_index_dir": str(
                resolve_colbert_bundle_artifacts(resolved_index_dir).colbert_index_dir
            ),
            "query": query,
            "k": k,
            "force_fast": force_fast,
        },
    )

    hits: list[ColbertQueryHit] = []
    for raw_hit in worker_payload.get("hits", []):
        if not isinstance(raw_hit, dict):
            continue
        document_metadata = raw_hit.get("document_metadata")
        if not isinstance(document_metadata, dict):
            document_metadata = None
        chunk_id = raw_hit.get("chunk_id") or raw_hit.get("document_id")
        if not isinstance(chunk_id, str) and document_metadata is not None:
            chunk_id = document_metadata.get("chunk_id")
        if not isinstance(chunk_id, str) or not chunk_id:
            raise RuntimeError(f"ColBERT worker result missing chunk identifier: {raw_hit}")

        manifest_row = manifest_rows.get(chunk_id)
        if manifest_row is None:
            raise RuntimeError(
                "ColBERT worker returned a chunk_id that does not exist in chunk_manifest.jsonl: "
                f"{chunk_id}"
            )

        hits.append(
            ColbertQueryHit(
                rank=int(raw_hit.get("rank", len(hits) + 1)),
                chunk_id=chunk_id,
                audio_hash=str(manifest_row["audio_hash"]),
                start_sec=float(manifest_row["start_sec"]),
                end_sec=float(manifest_row["end_sec"]),
                text=str(manifest_row["text"]),
                score=float(raw_hit.get("score", 0.0)),
                chunk_ordinal=int(manifest_row["chunk_ordinal"])
                if manifest_row.get("chunk_ordinal") is not None
                else None,
                document_metadata=document_metadata,
            )
        )

    return ColbertQueryResult(
        query=query,
        index_dir=str(resolved_index_dir),
        workflow_group_id=str(meta["workflow_group_id"]),
        backend_key=str(meta["backend_key"]),
        run_id=str(meta["run_id"]),
        chunk_version=str(meta["chunk_version"]),
        min_chunk_tokens=int(meta["min_chunk_tokens"])
        if meta.get("min_chunk_tokens") is not None
        else None,
        max_chunk_tokens=int(meta["max_chunk_tokens"])
        if meta.get("max_chunk_tokens") is not None
        else None,
        overlap_tokens=int(meta["overlap_tokens"])
        if meta.get("overlap_tokens") is not None
        else None,
        colbert_model=str(meta["colbert_model"]),
        doc_maxlen=int(meta["doc_maxlen"]),
        hits=hits,
    )


def lookup_colbert_chunks(
    *,
    index_dir: Path | str,
    chunk_ids: Sequence[str],
) -> list[RagChunk]:
    """Load chunk rows for ColBERT hits from the bundle-local chunk store."""

    if not chunk_ids:
        return []

    resolved_index_dir = Path(index_dir).resolve()
    worker_payload = _run_colbert_worker(
        command="lookup-chunks",
        payload={
            "colbert_index_dir": str(
                resolve_colbert_bundle_artifacts(resolved_index_dir).colbert_index_dir
            ),
            "chunk_ids": list(chunk_ids),
        },
    )
    raw_chunks = worker_payload.get("chunks", [])
    if not isinstance(raw_chunks, list):
        raise RuntimeError(f"Unexpected ColBERT chunk lookup payload: {type(raw_chunks)!r}")
    return [_coerce_rag_chunk(chunk) for chunk in raw_chunks if isinstance(chunk, dict)]


def lookup_colbert_neighbors(
    *,
    index_dir: Path | str,
    chunk_ids: Sequence[str],
    neighbor_count: int,
) -> dict[str, ChunkNeighbors]:
    """Load before/after neighbor chunks from the bundle-local chunk store."""

    if not chunk_ids:
        return {}

    worker_payload = _run_colbert_worker(
        command="lookup-neighbors",
        payload={
            "colbert_index_dir": str(
                resolve_colbert_bundle_artifacts(Path(index_dir).resolve()).colbert_index_dir
            ),
            "chunk_ids": list(chunk_ids),
            "neighbor_count": neighbor_count,
        },
    )
    raw_neighbors = worker_payload.get("neighbors", {})
    if not isinstance(raw_neighbors, dict):
        raise RuntimeError(f"Unexpected ColBERT neighbor payload: {type(raw_neighbors)!r}")

    neighbors: dict[str, ChunkNeighbors] = {}
    for chunk_id, value in raw_neighbors.items():
        if not isinstance(chunk_id, str):
            continue
        if not isinstance(value, dict):
            raise RuntimeError(f"Unexpected neighbor row shape for {chunk_id!r}.")
        before = value.get("before", [])
        after = value.get("after", [])
        if not isinstance(before, list) or not isinstance(after, list):
            raise RuntimeError(f"Unexpected neighbor row shape for {chunk_id!r}.")
        neighbors[chunk_id] = ChunkNeighbors(
            before=[_coerce_rag_chunk(chunk) for chunk in before if isinstance(chunk, dict)],
            after=[_coerce_rag_chunk(chunk) for chunk in after if isinstance(chunk, dict)],
        )
    return neighbors


__all__ = [
    "DEFAULT_COLBERT_MODEL",
    "resolve_default_colbert_model",
    "COLBERT_RUNTIME_CHOICES",
    "COLBERT_RUNTIME_DOCKER",
    "COLBERT_RUNTIME_DOCKER_INDEXER",
    "COLBERT_RUNTIME_ENV_VAR",
    "COLBERT_DOCKER_INDEXER_EXTERNAL_BUNDLE_DIR",
    "COLBERT_DOCKER_INDEXER_RUN_COMMAND",
    "DEFAULT_DOC_MAXLEN",
    "DEFAULT_INDEX_BSIZE",
    "DEFAULT_MAX_CHUNK_TOKENS",
    "DEFAULT_MIN_CHUNK_TOKENS",
    "DEFAULT_OVERLAP_TOKENS",
    "audit_colbert_token_lengths",
    "build_colbert_index",
    "check_colbert_runtime_ready",
    "default_colbert_index_runtime",
    "default_colbert_index_dir",
    "docker_runtime_supports_path",
    "host_has_nvidia_gpu",
    "lookup_colbert_chunks",
    "lookup_colbert_neighbors",
    "query_colbert_index",
    "sync_colbert_index",
    "validate_chunk_target_ids_against_manifest",
]
