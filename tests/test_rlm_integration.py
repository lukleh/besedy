from __future__ import annotations

import pickle
from typing import Any

import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("rlmbenchy", reason="requires the optional jobs extra")

from besedy.lib.prefect_jobs import rlm_integration  # noqa: E402


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def search_catalog(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("search_catalog", kwargs))
        return {"results": []}

    def get_chunk_window(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("get_chunk_window", kwargs))
        return {"contextText": "context"}

    def get_metadata(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("get_metadata", kwargs))
        return {"metadata": {}}


def test_signature_composes_request_instructions() -> None:
    signature = rlm_integration.build_besedy_deep_search_signature(
        "Focus on contradictory evidence."
    )

    assert "Use Besedy tools to retrieve evidence" in signature.instructions
    assert "Additional task instructions" in signature.instructions
    assert "Focus on contradictory evidence." in signature.instructions


def test_request_signature_round_trips_through_pickle() -> None:
    signature = rlm_integration.build_besedy_deep_search_signature(
        "Focus on contradictory evidence."
    )

    assert pickle.loads(pickle.dumps(signature)) is signature


def test_signature_and_tools_preserve_research_guidance() -> None:
    instructions = rlm_integration.BASE_BESEDY_DEEP_SEARCH_INSTRUCTIONS
    assert "questions and answers may not have clear boundaries" in instructions
    assert "Merge duplicates into one evidence cluster" in instructions
    assert "Recommended final structure:" in instructions

    tools = rlm_integration.build_besedy_deep_search_tools(
        client=_RecordingClient(),
        task_context_by_id={
            "task-1": {
                "catalog_id": "catalog-1",
                "retrieval": {},
                "window": {},
            }
        },
    )
    descriptions = {tool.name: tool.desc for tool in tools}
    assert "median about 246 tokens" in descriptions["search_catalog"]
    assert "`before` and `after` lists" in descriptions["get_chunk_window"]
    assert "Returns a JSON object with `metadata`" in descriptions["get_metadata"]


def test_instructions_retain_evidence_discipline_protocol() -> None:
    """Guard the quote-exactness, bucket-coverage, and reference-format rules.

    These sections were dropped once while moving the workload into Besedy, which
    silently weakened report quality without failing any test.
    """
    instructions = rlm_integration.BASE_BESEDY_DEEP_SEARCH_INSTRUCTIONS

    # Exact-quote discipline.
    assert "never use ellipses inside quotes to bridge omitted words" in instructions
    assert "Never use `...` or other ellipses inside exact quotes" in instructions

    # Candidate-source bucket taxonomy and coverage audits.
    assert "Group candidates by meaning before choosing final windows" in instructions
    assert "These identity buckets are not interchangeable" in instructions
    assert "Audit the final source plan as a bucket checklist" in instructions
    assert "Run a final coverage audit from ledger variables" in instructions

    # Final source plan and reference formatting.
    assert "build a final source plan from ledger variables" in instructions
    assert "preserve chunkId, audioHash, timestamp range" in instructions
    assert "Never truncate chunk IDs or audio hashes" in instructions

    # Context-bloat guard for the REPL transcript.
    assert "Do not print long transcript windows" in instructions

    # The full protocol, not a shortened variant.
    assert "13. If the evidence is narrow" in instructions
    assert len(instructions.splitlines()) == 60


def test_tool_warnings_keep_actionable_guidance() -> None:
    client = _RecordingClient()
    tools = {
        tool.name: tool.func
        for tool in rlm_integration.build_besedy_deep_search_tools(
            client=client,
            task_context_by_id={
                "task-1": {
                    "catalog_id": "catalog-1",
                    "retrieval": {"top_k": 200},
                    "window": {},
                }
            },
        )
    }

    with rlm_integration.active_task("task-1"):
        lowered = tools["search_catalog"]("query", top_k=5)
        first = tools["get_chunk_window"]("chunk-1")
        repeated = tools["get_chunk_window"]("chunk-1")

    assert "Use this only for targeted verification" in lowered["_warnings"][0]
    assert "_warnings" not in first
    assert "Reuse the existing variable" in repeated["_warnings"][0]


def test_tools_use_the_active_besedy_task_context() -> None:
    client = _RecordingClient()
    tools = {
        tool.name: tool.func
        for tool in rlm_integration.build_besedy_deep_search_tools(
            client=client,
            task_context_by_id={
                "task-1": {
                    "catalog_id": "catalog-1",
                    "retrieval": {
                        "top_k": 25,
                        "include_neighbors": True,
                        "neighbor_count": 2,
                    },
                    "window": {"neighbor_count": 3},
                }
            },
        )
    }

    with pytest.raises(RuntimeError, match="No active Besedy deep-search task"):
        tools["search_catalog"]("query")

    with rlm_integration.active_task("task-1"):
        tools["search_catalog"]("query")
        tools["get_chunk_window"]("chunk-1")
        tools["get_metadata"]("hash-1")

    assert client.calls == [
        (
            "search_catalog",
            {
                "catalog_id": "catalog-1",
                "query": "query",
                "top_k": 25,
                "include_neighbors": True,
                "neighbor_count": 2,
            },
        ),
        (
            "get_chunk_window",
            {
                "catalog_id": "catalog-1",
                "chunk_id": "chunk-1",
                "neighbor_count": 3,
            },
        ),
        (
            "get_metadata",
            {"catalog_id": "catalog-1", "audio_hash": "hash-1"},
        ),
    ]
