"""Prefect deep-search flow scaffold."""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, cast

from prefect import flow, task
from prefect.context import get_run_context
from prefect.states import State

from besedy.lib.internal_deep_search_client import (
    DeepSearchClientError,
    build_besedy_deep_search_client_from_env,
)

from ..artifacts import publish_prefect_artifacts, write_output_bundle
from ..json_types import JsonDict, coerce_json_dict, coerce_json_dict_list
from ..models import pick_json_value
from ..rlm_adapter import (
    DeepSearchExecutionMode,
    RlmAdapterError,
    resolve_deep_search_execution_mode,
    run_rlmbenchy_deep_search,
)


class DeepSearchFlowError(RuntimeError):
    """Raised for flow-side deep-search failures with retry/debug metadata."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retryable: bool = False,
        partial_result: JsonDict | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.partial_result = partial_result


def _default_output_root() -> Path:
    raw = os.getenv("DEEP_SEARCH_OUTPUT_DIR", "tmp/deep-search").strip() or "tmp/deep-search"
    return Path(raw).resolve()


def _should_retry_deep_search_error(_task: Any, _task_run: Any, state: State[Any]) -> bool:
    exc = state.result(raise_on_failure=False, retry_result_failure=False)
    return isinstance(exc, DeepSearchFlowError) and exc.retryable


@task
def validate_inputs(
    *,
    catalog_id: str,
    query: str,
    instructions: str | None = None,
    retrieval: JsonDict,
    execution: JsonDict,
) -> JsonDict:
    if not str(catalog_id).strip():
        raise ValueError("catalog_id must not be empty.")
    if not str(query).strip():
        raise ValueError("query must not be empty.")
    instructions_text = _string_or_none(instructions)
    if instructions_text is None:
        raise ValueError("instructions must not be empty.")
    inputs = {
        "catalog_id": str(catalog_id).strip(),
        "query": str(query).strip(),
        "instructions": instructions_text,
        "retrieval": retrieval if isinstance(retrieval, dict) else {},
        "execution": execution if isinstance(execution, dict) else {},
    }
    return inputs


@task(retries=2, retry_delay_seconds=5, retry_condition_fn=_should_retry_deep_search_error)
def run_initial_retrieval(inputs: JsonDict) -> JsonDict:
    query = str(inputs["query"])
    catalog_id = str(inputs["catalog_id"])
    client = build_besedy_deep_search_client_from_env()
    if client is None:
        time.sleep(0.1)
        return {
            "query": query,
            "retrieval": {},
            "timings": {},
            "hits": [
                {
                    "rank": 1,
                    "chunkId": "stub-chunk-1",
                    "audioHash": "stub-audio-1",
                    "score": 1.0,
                    "startSec": 10,
                    "endSec": 20,
                    "text": f"Stub initial hit for query: {query}",
                }
            ],
            "stub": True,
        }

    try:
        search_response = client.search_catalog(
            catalog_id=catalog_id,
            query=query,
            top_k=_resolve_top_k(inputs.get("retrieval")),
            include_neighbors=_resolve_include_neighbors(inputs.get("retrieval")),
            neighbor_count=_resolve_search_neighbor_count(inputs.get("retrieval")),
        )
    except DeepSearchClientError as exc:
        raise DeepSearchFlowError(
            f"Deep-search retrieval failed: {exc}",
            status_code=exc.status_code,
            retryable=_is_retryable_internal_error(exc.status_code),
        ) from exc

    return {
        "query": str(search_response.get("query") or query),
        "retrieval": _as_object(search_response.get("retrieval")),
        "timings": _as_object(search_response.get("timings")),
        "hits": _require_result_list(search_response),
        "stub": False,
    }


@task(retries=2, retry_delay_seconds=5, retry_condition_fn=_should_retry_deep_search_error)
def expand_citations(inputs: JsonDict, initial_retrieval: JsonDict) -> list[JsonDict]:
    if bool(initial_retrieval.get("stub")):
        return []

    client = build_besedy_deep_search_client_from_env()
    if client is None:
        raise DeepSearchFlowError(
            "Besedy deep-search client is not configured.",
            partial_result={
                "initialRetrieval": initial_retrieval,
                "citationExpansions": [],
                "failedStage": "citation_expansion",
            },
        )

    catalog_id = str(inputs["catalog_id"])
    hits = _list_of_objects(initial_retrieval.get("hits"))
    citation_limit = min(_resolve_citation_limit(inputs.get("execution")), len(hits))
    neighbor_count = _resolve_citation_neighbor_count(inputs.get("execution"))
    expansions: list[JsonDict] = []
    for item in hits[:citation_limit]:
        chunk_id = item.get("chunkId")
        if not isinstance(chunk_id, str) or not chunk_id.strip():
            raise ValueError("Initial retrieval payload is missing chunkId.")
        try:
            expansions.append(
                client.get_chunk_window(
                    catalog_id=catalog_id,
                    chunk_id=chunk_id,
                    neighbor_count=neighbor_count,
                )
            )
        except DeepSearchClientError as exc:
            raise DeepSearchFlowError(
                f"Deep-search citation expansion failed: {exc}",
                status_code=exc.status_code,
                retryable=_is_retryable_internal_error(exc.status_code),
                partial_result={
                    "initialRetrieval": initial_retrieval,
                    "citationExpansions": expansions,
                    "failedStage": "citation_expansion",
                    "failedChunkId": chunk_id,
                },
            ) from exc
    return expansions


@task
def run_rlm_deep_search(
    *,
    flow_run_id: str,
    inputs: JsonDict,
    initial_retrieval: JsonDict,
    citation_expansions: list[JsonDict],
) -> JsonDict:
    query = str(inputs["query"])
    instructions = _string_or_none(inputs.get("instructions"))
    hits = _list_of_objects(initial_retrieval.get("hits"))
    execution_mode = resolve_deep_search_execution_mode(
        execution=inputs.get("execution"),
        has_stub_retrieval=bool(initial_retrieval.get("stub")),
    )
    if execution_mode == DeepSearchExecutionMode.RLM:
        client = build_besedy_deep_search_client_from_env()
        if client is None:
            raise DeepSearchFlowError(
                "Besedy deep-search client is not configured.",
                retryable=False,
                partial_result={
                    "initialRetrieval": initial_retrieval,
                    "citationExpansions": citation_expansions,
                    "failedStage": "rlm_execution",
                    "traceExtras": {
                        "executionMode": "rlm",
                        "executor": "rlmbenchy_rlm",
                    },
                },
            )
        try:
            return run_rlmbenchy_deep_search(
                flow_run_id=flow_run_id,
                catalog_id=str(inputs["catalog_id"]),
                query=query,
                instructions=instructions,
                retrieval=inputs.get("retrieval"),
                execution=inputs.get("execution"),
                initial_retrieval=initial_retrieval,
                citation_expansions=citation_expansions,
                client=client,
                output_root_dir=_default_output_root(),
            )
        except RlmAdapterError as exc:
            raise DeepSearchFlowError(
                str(exc),
                status_code=exc.status_code,
                retryable=exc.retryable,
                partial_result={
                    "initialRetrieval": initial_retrieval,
                    "citationExpansions": citation_expansions,
                    "failedStage": "rlm_execution",
                    "traceExtras": {
                        "executionMode": "rlm",
                        "executor": "rlmbenchy_rlm",
                        **_as_object(exc.partial_trace),
                    },
                },
            ) from exc

    if execution_mode == DeepSearchExecutionMode.RETRIEVAL:
        return _build_retrieval_only_result(
            query=query,
            flow_run_id=flow_run_id,
            catalog_id=str(inputs["catalog_id"]),
            initial_trace=initial_retrieval,
            citation_expansions=citation_expansions,
        )

    time.sleep(0.1)
    markdown = (
        "# Deep Search (Prefect POC)\n\n"
        "## Query\n\n"
        f"{query}\n\n"
        "## Method\n\n"
        "This is the Prefect-backed deep-search scaffold. "
        "It proves deployment-backed execution, artifacts, and output bundles.\n\n"
        "## Initial Retrieval\n\n"
        f"- Retrieved {len(hits)} initial hit(s).\n\n"
        "## Findings\n\n"
        "- Stub flow completed successfully.\n"
        "- Real Besedy retrieval is not configured in this environment.\n"
        "- rlmbenchy synthesis is not wired yet.\n"
    )
    return {
        "query": query,
        "markdown": markdown,
        "report": {
            "title": "Deep Search (Prefect POC)",
            "sections": [
                {"title": "Query", "content": query},
                {"title": "Method", "content": "Prefect-backed stub deep-search flow."},
                {"title": "Initial Retrieval", "content": f"{len(hits)} initial hit(s)."},
            ],
        },
        "trace": {
            "initialRetrieval": initial_retrieval,
            "citationExpansions": citation_expansions,
            "followUpSearches": [],
            "executor": "prefect_stub",
            "executionMode": "stub",
            "stub": True,
        },
    }


@task
def persist_output_bundle(
    *,
    flow_run_id: str,
    inputs: JsonDict,
    initial_hits: list[JsonDict],
    result: JsonDict,
) -> JsonDict:
    output_root = _default_output_root()
    output_dir = write_output_bundle(
        root_dir=output_root,
        flow_run_id=flow_run_id,
        result=result,
        initial_hits=initial_hits,
        followup_trace=result.get("trace", {}) if isinstance(result.get("trace"), dict) else {},
        run_metadata={
            "flowRunId": flow_run_id,
            "catalogId": inputs["catalog_id"],
            "query": inputs["query"],
        },
    )
    return {"flowRunId": flow_run_id, "outputDir": str(output_dir)}


@task
def publish_final_artifacts(
    *,
    bundle_info: JsonDict,
    result: JsonDict,
    initial_hits: list[JsonDict],
) -> None:
    publish_prefect_artifacts(
        flow_run_id=str(bundle_info["flowRunId"]),
        result=result,
        initial_hits=initial_hits,
        output_dir=Path(str(bundle_info["outputDir"])),
    )


@flow(name="deep_search_flow", log_prints=True)
def deep_search_flow(
    catalog_id: str,
    query: str,
    instructions: str | None = None,
    requested_by_id: str | None = None,
    caller_scope: str | None = None,
    retrieval: JsonDict | None = None,
    execution: JsonDict | None = None,
) -> JsonDict:
    del requested_by_id, caller_scope
    context = cast(Any, get_run_context())
    flow_run = getattr(context, "flow_run", None)
    if flow_run is None:
        raise RuntimeError("deep_search_flow requires a Prefect flow-run context.")
    flow_run_id = str(flow_run.id)
    initial_hits: JsonDict | None = None
    citation_expansions: list[JsonDict] = []
    inputs = validate_inputs(
        catalog_id=catalog_id,
        query=query,
        instructions=instructions,
        retrieval=retrieval or {},
        execution=execution or {},
    )
    try:
        execution_mode = resolve_deep_search_execution_mode(
            execution=inputs.get("execution"),
            has_stub_retrieval=False,
        )
        if execution_mode == DeepSearchExecutionMode.RLM:
            initial_hits = {
                "query": inputs["query"],
                "retrieval": {},
                "timings": {},
                "hits": [],
                "stub": False,
            }
            citation_expansions = []
        else:
            initial_hits = run_initial_retrieval(inputs)
            citation_expansions = expand_citations(inputs, initial_hits)
        result = run_rlm_deep_search(
            flow_run_id=flow_run_id,
            inputs=inputs,
            initial_retrieval=initial_hits,
            citation_expansions=citation_expansions,
        )
        bundle_info = persist_output_bundle(
            flow_run_id=flow_run_id,
            inputs=inputs,
            initial_hits=_list_of_objects(initial_hits.get("hits")),
            result=result,
        )
        publish_final_artifacts(
            bundle_info=bundle_info,
            result=result,
            initial_hits=_list_of_objects(initial_hits.get("hits")),
        )
        return result
    except DeepSearchFlowError as exc:
        partial_payload = _as_object(exc.partial_result)
        partial_initial = _as_object(partial_payload.get("initialRetrieval"))
        if not partial_initial and isinstance(initial_hits, dict):
            partial_initial = initial_hits
        partial_citations = _list_of_objects(partial_payload.get("citationExpansions"))
        if not partial_citations and citation_expansions:
            partial_citations = citation_expansions
        partial_trace_extras = _as_object(partial_payload.get("traceExtras"))
        partial_execution_mode = _string_or_none(partial_trace_extras.get("executionMode"))
        partial_executor = _string_or_none(partial_trace_extras.get("executor"))
        if partial_initial:
            partial_result = _build_partial_failure_result(
                query=str(inputs["query"]),
                flow_run_id=flow_run_id,
                catalog_id=str(inputs["catalog_id"]),
                initial_trace=partial_initial,
                citation_expansions=partial_citations,
                error_message=str(exc),
                failed_stage=_string_or_none(partial_payload.get("failedStage")) or "execution",
                failed_chunk_id=_string_or_none(partial_payload.get("failedChunkId")),
                trace_extras=partial_trace_extras,
                execution_mode=partial_execution_mode,
                executor=partial_executor,
            )
            _persist_failure_output_bundle(
                flow_run_id=flow_run_id,
                inputs=inputs,
                initial_retrieval=partial_initial,
                result=partial_result,
            )
        raise


def _require_result_list(payload: JsonDict) -> list[JsonDict]:
    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        raise ValueError("Internal deep-search search payload is missing results.")
    return [item for item in raw_results if isinstance(item, dict)]


def _build_retrieval_only_result(
    *,
    query: str,
    flow_run_id: str,
    catalog_id: str,
    initial_trace: JsonDict,
    citation_expansions: list[JsonDict],
) -> JsonDict:
    hits = _list_of_objects(initial_trace.get("hits"))
    markdown_sections = [
        "# Deep Search (Retrieval POC)",
        "",
        "## Query",
        "",
        query,
        "",
        "## Method",
        "",
        "This report is generated by the Prefect-backed jobs service using Besedy internal retrieval APIs.",
        "It includes the worker's first retrieval pass plus citation expansion for the top hits.",
        "rlmbenchy synthesis is not wired yet.",
        "",
        "## Initial Retrieval",
        "",
    ]

    if not hits:
        markdown_sections.extend(
            [
                "No matching evidence was returned by the initial retrieval pass.",
                "",
            ]
        )
    else:
        for index, item in enumerate(hits, start=1):
            markdown_sections.extend(_format_initial_hit_markdown(index, item))

    markdown_sections.extend(["## Expanded Context", ""])
    if not citation_expansions:
        markdown_sections.extend(
            [
                "No citation expansions were generated.",
                "",
            ]
        )
    else:
        for index, expansion in enumerate(citation_expansions, start=1):
            markdown_sections.extend(_format_citation_markdown(index, expansion))

    markdown = "\n".join(markdown_sections).rstrip() + "\n"
    return {
        "query": query,
        "markdown": markdown,
        "report": {
            "title": "Deep Search (Retrieval POC)",
            "catalogId": catalog_id,
            "jobId": flow_run_id,
            "sections": [
                {"title": "Query", "content": query},
                {
                    "title": "Method",
                    "content": (
                        "Prefect jobs service -> Besedy internal retrieval endpoints. "
                        "rlmbenchy synthesis is not wired yet."
                    ),
                },
                {
                    "title": "Initial Retrieval",
                    "content": f"{len(hits)} hits returned.",
                },
                {
                    "title": "Expanded Context",
                    "content": f"{len(citation_expansions)} citation expansions returned.",
                },
            ],
        },
        "trace": {
            "initialRetrieval": initial_trace,
            "citationExpansions": citation_expansions,
            "followUpSearches": [],
            "executor": "besedy_internal_retrieval_poc",
            "executionMode": "retrieval",
            "stub": False,
            "rlmPlanned": True,
        },
    }


def _build_partial_failure_result(
    *,
    query: str,
    flow_run_id: str,
    catalog_id: str,
    initial_trace: JsonDict,
    citation_expansions: list[JsonDict],
    error_message: str,
    failed_stage: str,
    failed_chunk_id: str | None,
    trace_extras: JsonDict | None = None,
    execution_mode: str | None = None,
    executor: str | None = None,
) -> JsonDict:
    result = _build_retrieval_only_result(
        query=query,
        flow_run_id=flow_run_id,
        catalog_id=catalog_id,
        initial_trace=initial_trace,
        citation_expansions=citation_expansions,
    )
    markdown = str(result.get("markdown") or "").rstrip()
    failure_lines = [
        "",
        "## Failure",
        "",
        f"- stage: `{failed_stage}`",
    ]
    if failed_chunk_id:
        failure_lines.append(f"- chunk: `{failed_chunk_id}`")
    failure_lines.append(f"- error: {error_message}")
    result["markdown"] = "\n".join([markdown, *failure_lines]).rstrip() + "\n"

    report = _as_object(result.get("report"))
    if execution_mode == "rlm":
        report["title"] = "Deep Search (RLM Partial Failure)"
        sections = report.get("sections")
        if isinstance(sections, list) and len(sections) >= 2 and isinstance(sections[1], dict):
            sections[1]["content"] = (
                "Prefect jobs service -> Besedy internal retrieval endpoints -> "
                "rlmbenchy runtime execution. The run failed before a final synthesized answer "
                "was produced."
            )
        result["markdown"] = result["markdown"].replace(
            "# Deep Search (Retrieval POC)",
            "# Deep Search (RLM Partial Failure)",
            1,
        )
    sections = report.get("sections")
    if isinstance(sections, list):
        sections.append(
            {
                "title": "Failure",
                "content": error_message,
                "failedStage": failed_stage,
                "failedChunkId": failed_chunk_id,
                "partial": True,
            }
        )
    trace = _as_object(result.get("trace"))
    if trace_extras:
        trace.update(trace_extras)
    if execution_mode:
        trace["executionMode"] = execution_mode
    if executor:
        trace["executor"] = executor
    trace["failedStage"] = failed_stage
    trace["failedChunkId"] = failed_chunk_id
    trace["partial"] = True
    result["report"] = report
    result["trace"] = trace
    result["failure"] = {
        "message": error_message,
        "failedStage": failed_stage,
        "failedChunkId": failed_chunk_id,
        "partial": True,
    }
    return result


def _persist_failure_output_bundle(
    *,
    flow_run_id: str,
    inputs: JsonDict,
    initial_retrieval: JsonDict,
    result: JsonDict,
) -> None:
    try:
        output_root = _default_output_root()
        output_dir = write_output_bundle(
            root_dir=output_root,
            flow_run_id=flow_run_id,
            result=result,
            initial_hits=_list_of_objects(initial_retrieval.get("hits")),
            followup_trace=result.get("trace", {}) if isinstance(result.get("trace"), dict) else {},
            run_metadata={
                "flowRunId": flow_run_id,
                "catalogId": inputs["catalog_id"],
                "query": inputs["query"],
            },
        )
        publish_prefect_artifacts(
            flow_run_id=flow_run_id,
            result=result,
            initial_hits=_list_of_objects(initial_retrieval.get("hits")),
            output_dir=output_dir,
        )
    except Exception as exc:  # pragma: no cover - defensive runtime guard
        print(f"Failed to persist partial deep-search output bundle: {exc}")


def _resolve_top_k(retrieval: object) -> int:
    top_k = pick_json_value(retrieval, "top_k", "topK")
    if isinstance(top_k, int) and top_k > 0:
        return top_k
    return 200


def _resolve_include_neighbors(retrieval: object) -> bool:
    include_neighbors = pick_json_value(retrieval, "include_neighbors", "includeNeighbors")
    if isinstance(include_neighbors, bool):
        return include_neighbors
    return True


def _resolve_search_neighbor_count(retrieval: object) -> int:
    neighbor_count = pick_json_value(retrieval, "neighbor_count", "neighborCount")
    if isinstance(neighbor_count, int) and neighbor_count >= 0:
        return min(neighbor_count, 3)
    return 1


def _resolve_citation_limit(execution: object) -> int:
    citation_limit = pick_json_value(execution, "citation_limit", "citationLimit")
    if isinstance(citation_limit, int) and citation_limit > 0:
        return citation_limit
    return 3


def _resolve_citation_neighbor_count(execution: object) -> int:
    neighbor_count = pick_json_value(
        execution,
        "citation_neighbor_count",
        "citationNeighborCount",
    )
    if isinstance(neighbor_count, int) and neighbor_count >= 0:
        return neighbor_count
    return 1


def _format_initial_hit_markdown(index: int, item: JsonDict) -> list[str]:
    score = item.get("score")
    audio_hash = item.get("audioHash")
    chunk_id = item.get("chunkId")
    start_sec = item.get("startSec")
    end_sec = item.get("endSec")
    text = item.get("text")
    lines = [
        f"{index}. `{chunk_id}` score={_format_number(score)} audio=`{audio_hash}` "
        f"time={_format_number(start_sec)}-{_format_number(end_sec)}",
    ]
    if isinstance(text, str) and text.strip():
        lines.extend(["", text.strip(), ""])
    else:
        lines.append("")
    return lines


def _format_citation_markdown(index: int, expansion: JsonDict) -> list[str]:
    chunk = _as_object(expansion.get("chunk"))
    chunk_id = chunk.get("chunkId", f"chunk-{index}")
    context_text = expansion.get("contextText")
    metadata = _as_object(expansion.get("metadata"))

    lines = [f"### Hit {index}: `{chunk_id}`", ""]
    if metadata:
        location = _as_object(metadata.get("location"))
        recorder = _as_object(metadata.get("recorder"))
        date = _as_object(metadata.get("date"))
        lines.append(
            "- "
            f"date={_format_date(date)} "
            f"location={location.get('name') if location else 'n/a'} "
            f"recorder={recorder.get('name') if recorder else 'n/a'}"
        )
        lines.append("")
    if isinstance(context_text, str) and context_text.strip():
        lines.extend([context_text.strip(), ""])
    else:
        lines.extend(["No expanded context returned.", ""])
    return lines


def _as_object(value: object) -> JsonDict:
    return coerce_json_dict(value)


def _list_of_objects(value: object) -> list[JsonDict]:
    return coerce_json_dict_list(value)


def _format_number(value: object) -> str:
    if isinstance(value, int | float):
        return f"{value:.2f}" if isinstance(value, float) else str(value)
    return "n/a"


def _format_date(value: JsonDict) -> str:
    if not value:
        return "n/a"
    parts = [value.get("year"), value.get("month"), value.get("day")]
    rendered = [str(part) for part in parts if isinstance(part, int)]
    return "-".join(rendered) if rendered else "n/a"


def _is_retryable_internal_error(status_code: int | None) -> bool:
    if status_code is None:
        return False
    return status_code >= 500 or status_code in {408, 425, 429}


def _string_or_none(value: object) -> str | None:
    if isinstance(value, str):
        rendered = value.strip()
        return rendered or None
    return None
