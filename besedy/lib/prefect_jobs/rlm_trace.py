"""Trace/final-output helpers for the Prefect deep-search RLM adapter."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .json_types import JsonDict, coerce_json_dict, coerce_json_dict_list
from .rlm_runtime import LMResolution, ProfileResolution


def build_rlm_trace(
    *,
    lm: LMResolution,
    adapter_mode: str,
    repl_backend: str,
    log_dir: Path,
    loop_result_summary: JsonDict | None,
) -> JsonDict:
    summary = loop_result_summary or {}
    return {
        "main": profile_trace(lm.main),
        "sub": profile_trace(lm.sub),
        "adapterMode": adapter_mode,
        "replBackend": repl_backend,
        "logDir": str(log_dir),
        "stopReason": string_or_none(summary.get("stopReason")),
        "iterations": summary.get("iterations"),
        "error": string_or_none(summary.get("error")),
    }


def build_failure_partial_trace(
    *,
    tool_trace: JsonDict,
    lm: LMResolution,
    adapter_mode: str,
    repl_backend: str,
    log_dir: Path,
    loop_result_summary: JsonDict | None,
    execution_mode: str,
    executor_id: str,
    effective_retrieval: JsonDict | None = None,
    effective_execution: JsonDict | None = None,
) -> JsonDict:
    return {
        **tool_trace,
        "executionMode": execution_mode,
        "executor": executor_id,
        **({"effectiveRetrieval": effective_retrieval} if effective_retrieval else {}),
        **({"effectiveExecution": effective_execution} if effective_execution else {}),
        "rlm": build_rlm_trace(
            lm=lm,
            adapter_mode=adapter_mode,
            repl_backend=repl_backend,
            log_dir=log_dir,
            loop_result_summary=loop_result_summary,
        ),
    }


def profile_trace(resolution: ProfileResolution) -> JsonDict:
    profile = resolution.profile
    return {
        "ref": resolution.ref,
        "profilePath": str(resolution.path),
        "apiBase": getattr(profile, "api_base", None),
        "modelId": getattr(profile, "model", None),
    }


def normalize_rlm_final_answer(final_answer: str) -> tuple[str, JsonDict | None]:
    normalized = final_answer.strip()
    if not normalized:
        return final_answer, None
    try:
        parsed = json.loads(normalized)
    except json.JSONDecodeError:
        return final_answer.rstrip() + "\n", None
    if not isinstance(parsed, dict):
        return final_answer.rstrip() + "\n", None

    markdown = string_or_none(parsed.get("markdown"))
    report = as_object(parsed.get("report"))
    if markdown:
        return markdown.rstrip() + "\n", report or None
    return json.dumps(parsed, ensure_ascii=False, indent=2) + "\n", report or None


def first_nonempty_paragraph(markdown: str) -> str:
    for block in markdown.split("\n\n"):
        cleaned = block.strip()
        if cleaned and not cleaned.startswith("#"):
            return cleaned[:600]
    return markdown.strip()[:600]


def json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [json_safe(item) for item in value]
    return str(value)


def as_object(value: object) -> JsonDict:
    return coerce_json_dict(value)


def list_of_objects(value: object) -> list[JsonDict]:
    return coerce_json_dict_list(value)


def string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
