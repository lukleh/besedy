"""rlmbenchy adapter for Prefect-backed deep-search flows.

Loads LM profiles and drives ``rlmbenchy.rlm.run_task`` with Besedy-owned
deep-search tools.
"""

from __future__ import annotations

import os
from enum import StrEnum
from pathlib import Path
from typing import Any

from rlmbenchy.rlm import (
    extract_final_answer,
    is_retryable_tool_error,
    loop_result_summary,
    run_task,
)

from besedy.lib.internal_deep_search_client import (
    DeepSearchClient,
    DeepSearchClientError,
)

from .json_types import JsonDict, coerce_json_dict
from .models import pick_json_value
from .rlm_integration import (
    DEFAULT_RETRIEVAL_TOP_K,
    DEFAULT_SEARCH_INCLUDE_NEIGHBORS,
    DEFAULT_SEARCH_NEIGHBOR_COUNT,
    DEFAULT_WINDOW_NEIGHBOR_COUNT,
    MAX_SEARCH_NEIGHBOR_COUNT,
    MAX_WINDOW_NEIGHBOR_COUNT,
    active_task,
    build_besedy_deep_search_signature,
    build_besedy_deep_search_tools,
)
from .rlm_runtime import (
    LMResolution,
    build_repl_runtime,
    build_rlm_run_config_from_profile,
    build_sub_lm_from_profile,
    resolve_adapter_mode,
    resolve_lm_profiles,
    resolve_log_dir,
    resolve_repl_backend,
    resolve_seed,
)
from .rlm_trace import (
    as_object as _as_object,
)
from .rlm_trace import (
    build_failure_partial_trace,
    build_rlm_trace,
    first_nonempty_paragraph,
    normalize_rlm_final_answer,
)
from .rlm_trace import (
    json_safe as _json_safe,
)
from .rlm_trace import (
    list_of_objects as _list_of_objects,
)

DEFAULT_ADAPTER_MODE = "auto"
DEFAULT_SEED = 1
RLM_EXECUTOR_ID = "rlmbenchy_rlm"


class DeepSearchExecutionMode(StrEnum):
    STUB = "stub"
    RETRIEVAL = "retrieval"
    RLM = "rlm"


class RlmAdapterError(RuntimeError):
    """Raised when rlmbenchy execution cannot produce a final deep-search result."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
        partial_trace: JsonDict | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.partial_trace = partial_trace


class RlmToolRuntimeError(RuntimeError):
    """Raised when a Besedy-backed RLM tool fails after local retries."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable


def resolve_deep_search_execution_mode(
    *,
    execution: object,
    has_stub_retrieval: bool,
) -> DeepSearchExecutionMode:
    if has_stub_retrieval:
        return DeepSearchExecutionMode.STUB

    raw_mode = str(
        pick_json_value(execution, "mode", "execution_mode", "executionMode") or ""
    ).strip()
    if not raw_mode:
        raw_mode = str(os.getenv("DEEP_SEARCH_EXECUTION_MODE", "rlm")).strip()
    normalized = raw_mode.lower() or DeepSearchExecutionMode.RLM.value
    try:
        return DeepSearchExecutionMode(normalized)
    except ValueError as exc:
        raise ValueError(f"Unsupported deep-search execution mode: {raw_mode!r}.") from exc


def run_rlmbenchy_deep_search(
    *,
    flow_run_id: str,
    catalog_id: str,
    query: str,
    instructions: str | None = None,
    retrieval: object,
    execution: object,
    initial_retrieval: JsonDict,
    citation_expansions: list[JsonDict],
    client: DeepSearchClient,
    output_root_dir: Path,
) -> JsonDict:
    repl_backend = resolve_repl_backend()
    log_dir = resolve_log_dir(output_root_dir=output_root_dir, flow_run_id=flow_run_id)
    adapter_mode = resolve_adapter_mode(retrieval=retrieval, default_mode=DEFAULT_ADAPTER_MODE)
    seed = resolve_seed(default_seed=DEFAULT_SEED)
    instructions_text = _string_or_none(instructions)
    if instructions_text is None:
        raise RlmAdapterError("instructions must not be empty.")

    tool_trace: JsonDict = {
        "followUpSearches": [],
        "rlmCitationExpansions": [],
        "metadataLookups": [],
        "toolCalls": [],
    }

    try:
        _reject_legacy_bundle_configuration(retrieval=retrieval)
        lm = resolve_lm_profiles(retrieval=retrieval)
        main_run_config = build_rlm_run_config_from_profile(
            profile=lm.main.profile,
            adapter_mode=adapter_mode,
            seed=seed,
        )
        sub_lm_instance = build_sub_lm_from_profile(
            profile=lm.sub.profile,
            seed=seed,
        )
        signature = build_besedy_deep_search_signature(instructions_text)
        runtime = build_repl_runtime(repl_backend=repl_backend)
        effective_workload_config = _resolve_effective_workload_config(
            retrieval=retrieval,
            execution=execution,
        )
    except RlmAdapterError:
        raise
    except Exception as exc:  # pragma: no cover - depends on host runtime
        raise RlmAdapterError(f"Failed to initialize rlmbenchy: {exc}") from exc

    run_metadata = {
        "runner": "rlm",
        "run_scope": "task",
        "lm_profile_path": str(lm.main.path),
        "sub_lm_profile_path": str(lm.sub.path),
        "adapter_mode": adapter_mode,
        "repl_backend": repl_backend,
        "seed": seed,
        "workload": "besedy_deep_search",
        "instructions": instructions_text,
    }

    task_id = "task_1"
    tools = _build_rlm_tools(
        client=client,
        catalog_id=catalog_id,
        effective_workload_config=effective_workload_config,
        task_id=task_id,
        tool_trace=tool_trace,
    )
    effective_retrieval_trace = _effective_retrieval_trace(effective_workload_config)
    effective_execution_trace = _effective_execution_trace(
        lm=lm,
        adapter_mode=adapter_mode,
        repl_backend=repl_backend,
        seed=seed,
        log_dir=log_dir,
    )

    try:
        task_inputs = {"query": query}
        task_started_data = {
            "workload": "besedy_deep_search",
            "query": query,
            "instructions": instructions_text,
        }

        with active_task(task_id):
            task_run, _ = run_task(
                signature=signature,
                run_config=main_run_config,
                task_inputs=task_inputs,
                task_id=task_id,
                log_dir=str(log_dir),
                tools=tools,
                runtime=runtime,
                sub_lm=sub_lm_instance,
                expected_answer=None,
                run_metadata=run_metadata,
                task_started_data=task_started_data,
            )
    except Exception as exc:
        status_code = _status_code_from_exception(exc)
        retryable = (
            isinstance(exc, RlmToolRuntimeError) and exc.retryable
        ) or _is_retryable_internal_error(status_code)
        raise RlmAdapterError(
            f"rlmbenchy execution failed: {type(exc).__name__}: {exc}",
            status_code=status_code,
            retryable=retryable,
            partial_trace=build_failure_partial_trace(
                tool_trace=tool_trace,
                lm=lm,
                adapter_mode=adapter_mode,
                repl_backend=repl_backend,
                log_dir=log_dir,
                loop_result_summary=None,
                execution_mode=DeepSearchExecutionMode.RLM.value,
                executor_id=RLM_EXECUTOR_ID,
                effective_retrieval=effective_retrieval_trace,
                effective_execution=effective_execution_trace,
            ),
        ) from exc

    loop_result = task_run.loop_result
    final_answer = extract_final_answer(task_run)
    loop_summary = loop_result_summary(loop_result)
    rlm_trace = build_rlm_trace(
        lm=lm,
        adapter_mode=adapter_mode,
        repl_backend=repl_backend,
        log_dir=log_dir,
        loop_result_summary=loop_summary,
    )

    if not final_answer:
        raise RlmAdapterError(
            "rlmbenchy finished without a final answer.",
            retryable=bool(is_retryable_tool_error(loop_result)),
            partial_trace={
                **tool_trace,
                "executionMode": DeepSearchExecutionMode.RLM.value,
                "executor": RLM_EXECUTOR_ID,
                "effectiveRetrieval": effective_retrieval_trace,
                "effectiveExecution": effective_execution_trace,
                "rlm": rlm_trace,
            },
        )

    markdown, structured_report = normalize_rlm_final_answer(final_answer)
    return {
        "query": query,
        "markdown": markdown,
        "report": structured_report
        or {
            "title": "Deep Search (RLM)",
            "catalogId": catalog_id,
            "jobId": flow_run_id,
            "sections": [
                {"title": "Query", "content": query},
                {
                    "title": "Method",
                    "content": (
                        "Prefect jobs service -> Besedy internal retrieval endpoints -> "
                        f"rlmbenchy runtime (main={lm.main.profile.model}, "
                        f"sub={lm.sub.profile.model})."
                    ),
                },
                {
                    "title": "Synthesis",
                    "content": first_nonempty_paragraph(markdown),
                },
            ],
        },
        "trace": {
            "initialRetrieval": initial_retrieval,
            "citationExpansions": citation_expansions,
            "followUpSearches": _list_of_objects(tool_trace.get("followUpSearches")),
            "rlmCitationExpansions": _list_of_objects(tool_trace.get("rlmCitationExpansions")),
            "metadataLookups": _list_of_objects(tool_trace.get("metadataLookups")),
            "rlmToolCalls": _list_of_objects(tool_trace.get("toolCalls")),
            "executor": RLM_EXECUTOR_ID,
            "workload": "besedy_deep_search",
            "executionMode": DeepSearchExecutionMode.RLM.value,
            "stub": False,
            "effectiveRetrieval": effective_retrieval_trace,
            "effectiveExecution": effective_execution_trace,
            "rlm": rlm_trace,
        },
    }


# ---------------------------------------------------------------------------
# LM profile / run-config resolution
# ---------------------------------------------------------------------------


def _reject_legacy_bundle_configuration(*, retrieval: object) -> None:
    retrieval_payload = coerce_json_dict(retrieval)
    for key in ("bundle_key", "bundleKey"):
        value = retrieval_payload.get(key)
        if isinstance(value, str) and value.strip():
            raise RlmAdapterError(
                "Legacy bundle-based LM selection has been removed. "
                "Use retrieval.lm_profile and retrieval.sub_lm_profile instead."
            )

    legacy_bundle_key = os.getenv("RLMBENCHY_BUNDLE_KEY", "").strip()
    if legacy_bundle_key:
        raise RlmAdapterError(
            "RLMBENCHY_BUNDLE_KEY is no longer supported. "
            "Use RLMBENCHY_LM_PROFILE and RLMBENCHY_SUB_LM_PROFILE instead."
        )


# ---------------------------------------------------------------------------
# Besedy tool wrappers for the RLM
# ---------------------------------------------------------------------------


def _build_rlm_tools(
    *,
    client: DeepSearchClient,
    catalog_id: str,
    effective_workload_config: JsonDict,
    task_id: str,
    tool_trace: JsonDict,
) -> list[Any]:
    tracing_client = _TracingWorkloadDeepSearchClient(
        client=client,
        tool_trace=tool_trace,
    )
    task_context_by_id = {
        task_id: {
            "catalog_id": catalog_id,
            "retrieval": coerce_json_dict(effective_workload_config.get("retrieval")),
            "window": coerce_json_dict(effective_workload_config.get("window")),
        },
    }
    return build_besedy_deep_search_tools(
        client=tracing_client,
        task_context_by_id=task_context_by_id,
    )


class _TracingWorkloadDeepSearchClient:
    def __init__(
        self,
        *,
        client: DeepSearchClient,
        tool_trace: JsonDict,
    ) -> None:
        self._client = client
        self._tool_trace = tool_trace

    def search_catalog(
        self,
        *,
        catalog_id: str,
        query: str,
        top_k: int,
        include_neighbors: bool = True,
        neighbor_count: int = 1,
    ) -> JsonDict:
        args = {
            "query": query,
            "top_k": top_k,
            "include_neighbors": include_neighbors,
            "neighbor_count": neighbor_count,
        }
        try:
            result = self._client.search_catalog(
                catalog_id=catalog_id,
                query=query,
                top_k=top_k,
                include_neighbors=include_neighbors,
                neighbor_count=neighbor_count,
            )
        except DeepSearchClientError as exc:
            _record_tool_error(
                tool_trace=self._tool_trace,
                tool_name="search_catalog",
                args=args,
                exc=exc,
            )
            raise
        _record_tool_success(
            tool_trace=self._tool_trace,
            tool_name="search_catalog",
            args=args,
            result=result,
        )
        return result

    def get_chunk_window(
        self,
        *,
        catalog_id: str,
        chunk_id: str,
        neighbor_count: int,
    ) -> JsonDict:
        args = {"chunk_id": chunk_id, "neighbor_count": neighbor_count}
        try:
            result = self._client.get_chunk_window(
                catalog_id=catalog_id,
                chunk_id=chunk_id,
                neighbor_count=neighbor_count,
            )
        except DeepSearchClientError as exc:
            _record_tool_error(
                tool_trace=self._tool_trace,
                tool_name="get_chunk_window",
                args=args,
                exc=exc,
            )
            raise
        _record_tool_success(
            tool_trace=self._tool_trace,
            tool_name="get_chunk_window",
            args=args,
            result=result,
        )
        return result

    def get_metadata(
        self,
        *,
        catalog_id: str,
        audio_hash: str,
    ) -> JsonDict:
        args = {"audio_hash": audio_hash}
        try:
            result = self._client.get_metadata(
                catalog_id=catalog_id,
                audio_hash=audio_hash,
            )
        except DeepSearchClientError as exc:
            _record_tool_error(
                tool_trace=self._tool_trace,
                tool_name="get_metadata",
                args=args,
                exc=exc,
            )
            raise
        _record_tool_success(
            tool_trace=self._tool_trace,
            tool_name="get_metadata",
            args=args,
            result=result,
        )
        return result


def _normalize_workload_retrieval(
    *,
    retrieval: object,
) -> JsonDict:
    payload = coerce_json_dict(retrieval)
    return {
        "top_k": _resolve_positive_int(
            pick_json_value(payload, "top_k", "topK"),
            default=DEFAULT_RETRIEVAL_TOP_K,
        ),
        "include_neighbors": _resolve_bool(
            pick_json_value(payload, "include_neighbors", "includeNeighbors"),
            default=DEFAULT_SEARCH_INCLUDE_NEIGHBORS,
        ),
        "neighbor_count": _resolve_bounded_nonnegative_int(
            pick_json_value(payload, "neighbor_count", "neighborCount"),
            default=DEFAULT_SEARCH_NEIGHBOR_COUNT,
            maximum=MAX_SEARCH_NEIGHBOR_COUNT,
        ),
    }


def _resolve_effective_workload_config(
    *,
    retrieval: object,
    execution: object,
) -> JsonDict:
    return {
        "retrieval": _normalize_workload_retrieval(
            retrieval=retrieval,
        ),
        "window": _normalize_workload_window(
            retrieval=retrieval,
            execution=execution,
        ),
    }


def _effective_retrieval_trace(effective_workload_config: JsonDict) -> JsonDict:
    retrieval = coerce_json_dict(effective_workload_config.get("retrieval"))
    window = coerce_json_dict(effective_workload_config.get("window"))
    return {
        "topK": retrieval.get("top_k"),
        "includeNeighbors": retrieval.get("include_neighbors"),
        "neighborCount": retrieval.get("neighbor_count"),
        "windowNeighborCount": window.get("neighbor_count"),
    }


def _effective_execution_trace(
    *,
    lm: LMResolution,
    adapter_mode: str,
    repl_backend: str,
    seed: int,
    log_dir: Path,
) -> JsonDict:
    return {
        "mode": DeepSearchExecutionMode.RLM.value,
        "executor": RLM_EXECUTOR_ID,
        "workload": "besedy_deep_search",
        "adapterMode": adapter_mode,
        "replBackend": repl_backend,
        "seed": seed,
        "logDir": str(log_dir),
        "lmProfile": lm.main.ref,
        "lmProfilePath": str(lm.main.path),
        "lmModelId": getattr(lm.main.profile, "model", None),
        "subLmProfile": lm.sub.ref,
        "subLmProfilePath": str(lm.sub.path),
        "subLmModelId": getattr(lm.sub.profile, "model", None),
    }


def _normalize_workload_window(
    *,
    retrieval: object,
    execution: object,
) -> JsonDict:
    retrieval_payload = coerce_json_dict(retrieval)
    execution_payload = coerce_json_dict(execution)
    window_payload = coerce_json_dict(retrieval_payload.get("window"))
    if not window_payload:
        window_payload = coerce_json_dict(execution_payload.get("window"))
    neighbor_count = pick_json_value(window_payload, "neighbor_count", "neighborCount")
    if neighbor_count is None:
        neighbor_count = pick_json_value(
            execution_payload,
            "window_neighbor_count",
            "windowNeighborCount",
            "citation_neighbor_count",
            "citationNeighborCount",
        )
    return {
        "neighbor_count": _resolve_bounded_nonnegative_int(
            neighbor_count,
            default=DEFAULT_WINDOW_NEIGHBOR_COUNT,
            maximum=MAX_WINDOW_NEIGHBOR_COUNT,
        )
    }


def _resolve_positive_int(value: object, *, default: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return int(value)
    return default


def _resolve_bounded_nonnegative_int(value: object, *, default: int, maximum: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return max(0, min(int(value), maximum))
    return default


def _resolve_bool(value: object, *, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _record_tool_success(
    *,
    tool_trace: JsonDict,
    tool_name: str,
    args: JsonDict,
    result: JsonDict,
    attempts: int = 1,
) -> None:
    entry = {
        "tool": tool_name,
        "args": _json_safe(args),
        "status": "ok",
        "attempts": attempts,
    }
    if tool_name == "search_catalog":
        results = _list_of_objects(result.get("results"))
        metrics = _summarize_search_results(results)
        tool_trace.setdefault("followUpSearches", []).append(
            {
                "query": args.get("query"),
                "topK": args.get("top_k"),
                "includeNeighbors": args.get("include_neighbors"),
                "neighborCount": args.get("neighbor_count"),
                "resultCount": len(results),
                **metrics,
                "results": results,
            }
        )
        entry["resultCount"] = len(results)
        entry.update(metrics)
    elif tool_name in {"expand_citation", "get_chunk_window"}:
        tool_trace.setdefault("rlmCitationExpansions", []).append(_json_safe(result))
        entry["chunkId"] = _as_object(result.get("chunk")).get("chunkId")
        entry.update(_summarize_chunk_window(result))
    elif tool_name == "get_metadata":
        tool_trace.setdefault("metadataLookups", []).append(_json_safe(result))
        entry["audioHash"] = result.get("audioHash")
    tool_trace.setdefault("toolCalls", []).append(entry)


def _record_tool_error(
    *,
    tool_trace: JsonDict,
    tool_name: str,
    args: JsonDict,
    exc: DeepSearchClientError,
    attempts: int = 1,
) -> None:
    tool_trace.setdefault("toolCalls", []).append(
        {
            "tool": tool_name,
            "args": _json_safe(args),
            "status": "error",
            "attempts": attempts,
            "statusCode": exc.status_code,
            "error": str(exc),
        }
    )


def _summarize_search_results(results: list[JsonDict]) -> JsonDict:
    chunk_ids = [_string_or_none(item.get("chunkId")) for item in results]
    audio_hashes = [_string_or_none(item.get("audioHash")) for item in results]
    unique_chunks = {value for value in chunk_ids if value}
    unique_audio_hashes = {value for value in audio_hashes if value}
    return {
        "textCharCount": sum(_text_length(item.get("text")) for item in results),
        "contextCharCount": sum(_text_length(item.get("contextText")) for item in results),
        "uniqueChunkCount": len(unique_chunks),
        "uniqueAudioHashCount": len(unique_audio_hashes),
        "duplicateChunkCount": max(
            0, len([value for value in chunk_ids if value]) - len(unique_chunks)
        ),
    }


def _summarize_chunk_window(result: JsonDict) -> JsonDict:
    chunk = _as_object(result.get("chunk"))
    neighbor_chunks = _chunk_window_neighbors(result)
    chunk_ids = [
        _string_or_none(chunk.get("chunkId")),
        *[_string_or_none(item.get("chunkId")) for item in neighbor_chunks],
    ]
    audio_hashes = [
        _string_or_none(chunk.get("audioHash")),
        *[_string_or_none(item.get("audioHash")) for item in neighbor_chunks],
    ]
    unique_chunks = {value for value in chunk_ids if value}
    unique_audio_hashes = {value for value in audio_hashes if value}
    return {
        "textCharCount": _text_length(chunk.get("text")),
        "contextCharCount": _text_length(result.get("contextText")),
        "neighborChunkCount": len(neighbor_chunks),
        "uniqueChunkCount": len(unique_chunks),
        "uniqueAudioHashCount": len(unique_audio_hashes),
    }


def _chunk_window_neighbors(result: JsonDict) -> list[JsonDict]:
    neighbors = _as_object(result.get("neighbors"))
    output: list[JsonDict] = []
    for key in ("before", "after"):
        output.extend(_list_of_objects(neighbors.get(key)))
    return output


def _text_length(value: object) -> int:
    return len(value) if isinstance(value, str) else 0


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _status_code_from_exception(exc: Exception) -> int | None:
    if isinstance(exc, RlmToolRuntimeError):
        return exc.status_code
    if isinstance(exc, DeepSearchClientError):
        return exc.status_code
    return None


def _is_retryable_internal_error(status_code: int | None) -> bool:
    return status_code in {429, 502, 503, 504}
