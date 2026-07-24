"""rlmbenchy log projection adapters for Prefect job summaries."""

from __future__ import annotations

from pathlib import Path

from rlmbenchy.logger.api import load_latest_run, run_calls, summarize_run_progress

from .json_types import JsonDict, coerce_json_dict, coerce_json_dict_list


def load_rlm_progress(*, root_dir: Path, flow_run_id: str) -> JsonDict | None:
    log_dir = root_dir / flow_run_id / "rlmbenchy"
    if not log_dir.is_dir():
        return None

    try:
        run_projection = load_latest_run(log_dir)
    except Exception:
        return None

    if not isinstance(run_projection, dict):
        return None

    try:
        generic_progress = coerce_json_dict(summarize_run_progress(run_projection))
        tool_metrics = _tool_progress_metrics(run_calls(run_projection, kind="tool"))
    except Exception:
        return None

    return {
        "steps": _int(generic_progress.get("steps")),
        "toolCalls": _int(generic_progress.get("toolCalls")),
        "subLlmCalls": _int(generic_progress.get("subLlmCalls")),
        "searchCalls": tool_metrics["searchCalls"],
        "windowCalls": tool_metrics["windowCalls"],
        "uniqueChunks": len(tool_metrics["chunkIds"]),
        "uniqueAudioHashes": len(tool_metrics["audioHashes"]),
        "retrievedTextChars": tool_metrics["retrievedTextChars"],
        "retrievedContextChars": tool_metrics["retrievedContextChars"],
    }


def _tool_progress_metrics(calls: object) -> JsonDict:
    search_calls = 0
    window_calls = 0
    retrieved_text_chars = 0
    retrieved_context_chars = 0
    chunk_ids: set[str] = set()
    audio_hashes: set[str] = set()

    for call in calls if isinstance(calls, list) else []:
        payload = coerce_json_dict(call)
        tool_name = str(payload.get("name") or "").strip()
        response = coerce_json_dict(payload.get("response"))
        result = coerce_json_dict(response.get("result"))

        if tool_name == "search_catalog":
            search_calls += 1
            for item in coerce_json_dict_list(result.get("results")):
                _add_optional_string(chunk_ids, item.get("chunkId"))
                _add_optional_string(audio_hashes, item.get("audioHash"))
                retrieved_text_chars += _text_length(item.get("text"))
                retrieved_context_chars += _text_length(item.get("contextText"))
        elif tool_name == "get_chunk_window":
            window_calls += 1
            chunk = coerce_json_dict(result.get("chunk"))
            _add_optional_string(chunk_ids, chunk.get("chunkId"))
            _add_optional_string(audio_hashes, chunk.get("audioHash"))
            retrieved_text_chars += _text_length(chunk.get("text"))
            retrieved_context_chars += _text_length(result.get("contextText"))
            neighbors = coerce_json_dict(result.get("neighbors"))
            for key in ("before", "after"):
                for item in coerce_json_dict_list(neighbors.get(key)):
                    _add_optional_string(chunk_ids, item.get("chunkId"))
                    _add_optional_string(audio_hashes, item.get("audioHash"))

    return {
        "searchCalls": search_calls,
        "windowCalls": window_calls,
        "retrievedTextChars": retrieved_text_chars,
        "retrievedContextChars": retrieved_context_chars,
        "chunkIds": chunk_ids,
        "audioHashes": audio_hashes,
    }


def _add_optional_string(values: set[str], value: object) -> None:
    if value is None:
        return
    normalized = str(value).strip()
    if normalized:
        values.add(normalized)


def _text_length(value: object) -> int:
    return len(value) if isinstance(value, str) else 0


def _int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                return int(float(text))
            except ValueError:
                return 0
    return 0
