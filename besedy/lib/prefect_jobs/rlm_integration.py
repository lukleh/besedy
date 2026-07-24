"""Besedy-owned signature and tools for the generic rlmbenchy runtime."""

from __future__ import annotations

import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from hashlib import sha256
from typing import Any, Callable

import dspy
from rlmbenchy.rlm import SignatureFieldSpec, build_task_signature

from besedy.lib.internal_deep_search_client import (
    DeepSearchClient,
    DeepSearchClientError,
)

from .json_types import coerce_json_dict

JsonDict = dict[str, Any]

DEFAULT_RETRIEVAL_TOP_K = 200
DEFAULT_SEARCH_INCLUDE_NEIGHBORS = True
DEFAULT_SEARCH_NEIGHBOR_COUNT = 1
DEFAULT_WINDOW_NEIGHBOR_COUNT = 1
MAX_SEARCH_NEIGHBOR_COUNT = 3
MAX_WINDOW_NEIGHBOR_COUNT = 5

_ACTIVE_TASK_ID: ContextVar[str | None] = ContextVar(
    "besedy_deep_search_active_task_id", default=None
)


BASE_BESEDY_DEEP_SEARCH_INSTRUCTIONS = """\
Investigate the Besedy catalog and answer as a Czech markdown research report.

Requirements:
- The `query` input says what information to gather from the catalog.
- The runtime provides the query as both a signature input and a REPL variable.
- Use Besedy tools to retrieve evidence before answering.
- Ground claims in retrieved evidence; cite chunk IDs, audio hashes, and timestamps when available.
- Support central claims with short exact Czech quotes copied from inspected context, not paraphrased snippets. Prefer the densest quote that explicitly names the queried concepts or relation being claimed. A quoted evidence span must be contiguous exact source text; never use ellipses inside quotes to bridge omitted words.
- If the evidence is ambiguous or incomplete, say so explicitly.
- Return markdown only.
- Write the final answer in natural Czech.

Report protocol:
- Produce a comprehensive, coherent, and well-structured explanation that helps the reader understand the queried subject in the context of the Besedy catalog.
- Treat the answer as a substantial explanatory research report, not a lightweight Q&A response.
- Prefer depth, careful distinctions, and explanatory scaffolding over brevity. Do not compress complex subjects into a short direct answer.
- Make the report educational and methodological: explain what the evidence says, how the pieces were connected, where interpretation begins, and what limits the conclusion.
- Account for the source material being messy multi-speaker discussion: questions and answers may not have clear boundaries, speakers may interrupt or branch into examples, topics may disappear and return later, and transcription errors may distort wording.
- Inspect surrounding context for important snippets and separate main claims from digressions, jokes, examples, and uncertain formulations.
- Treat very similar passages carefully. Some events may have been recorded by multiple recorders or transcribed by multiple models, so overlapping passages are not necessarily independent evidence. Merge duplicates into one evidence cluster instead of counting them as separate support.
- Recommended final structure:
  1. Orientation: frame the subject, state the scope of the answer, and give the main thesis without oversimplifying it.
  2. Context in the catalog: where and how the topic appears, including important conversation settings or recurring terms.
  3. Conceptual map: define the important distinctions, tensions, and related concepts needed to understand the subject.
  4. Main findings: clearly separated evidence-backed points with explanation, examples, and cross-references between passages.
  5. Synthesis: explain how the pieces fit together, what pattern emerges, and how strong that interpretation is.
  6. Methodological notes, uncertainties, and limits: what was searched, what cannot be concluded, where transcript errors, duplicate recordings, missing context, or thin evidence may matter.
  7. Suggested follow-up directions if the topic needs deeper investigation.
  8. References: at the end of the document, collect the specific evidence used, including chunk IDs, audio hashes, timestamps, and other available identifiers.

Research protocol:
1. Start with broad retrieval using `search_catalog(query)` without lowering the configured defaults.
2. Run at least two follow-up searches using alternate wording, synonyms, or related concepts. For relation questions, include role/function terms and bridge terms, not only the nouns in the query. If the query asks how one local or ambiguous usage fits into a broader map, run at least one follow-up search for the broader relation itself without the local wording.
3. Build an evidence ledger in Python before drafting. Track searches run, candidate chunks, rejected chunks with reasons, unique chunk IDs, unique audio hashes, timestamps, exact Czech quotes, duplicate/near-duplicate clusters, candidate-source buckets, which claims each chunk supports, and the final source plan.
4. Group candidates by meaning before choosing final windows. For relation questions, keep separate buckets for direct definitions, direct bridge formulations, function contrasts, metaphors/analogies, equivalence or celistvost claims, embodiment/expression claims, caveats or uncertainty, and duplicate variants when they appear. For identity or translation questions, also keep separate buckets for lexical equivalence, lived self-experience such as `pocit já` or `individuální duše`, universal/substance relations such as `Atman`/`Brahman` or `kapka`/`oceán`, and caveats such as `egoismus`, roles, forgetting, or samskáry/vasány. These identity buckets are not interchangeable: a clean `Atman`/`Brahman` or `kapka`/`oceán` source cannot replace a direct `já` / `pocit já` / `individuální duše` / `duše, ego, já, Atman` bridge when the query asks how all of those terms relate. A lived-self bucket is not satisfied by any isolated `pocit já` mention; it must connect the lived self back to `duše`/`individuální duše` or to multiple queried identity terms in the same source window. Do not classify only by exact keyword matches; Czech variants such as `pozorující`, `dívá se`, `prožívající část`, `zprostředkovatel`, `stejný materiál`, and `hmotná duše` may carry the same relation meaning.
5. If a central candidate-source bucket is empty, weak, or dominated by near-duplicate recordings after the first searches, run a targeted follow-up search for that missing meaning or distinct formulation before drafting. Do not substitute a tangential body-needs, body-as-obstacle, or generic spiritual/physical passage for an embodiment/expression, equivalence/aspect, or direct-bridge bucket unless it directly explains the queried relation. For high-risk non-interchangeable buckets, do not stop at the first plausible hit: inspect at least two non-duplicate candidate windows when retrieval returns them, then choose the quote that ties the bucket terms to the claim most directly. If only one candidate exists, record that limitation in the final source plan. For identity questions that connect `já`, `ego`, `Atman`, and `duše`, search again with the missing bridge terms together if the final plan has only separate lexical and universal/substance sources but no dense lived-self-to-soul bridge. If the query includes body as part of a relation, do not let same-material, celistvost, or role/function sources replace a distinct embodiment/expression source; search for and cite a source that directly presents body as expression, physical form, manifestation, or visible side of soul when the synthesis uses that claim.
6. When a strong source has near-duplicate transcript variants, inspect the duplicate variants and choose the clearest, least-noisy exact Czech quote for the final reference. If a relation quote is noisy, fragmented, or omits one side of the relation, run a targeted quote-cleanup search using the role words discovered in the window plus both related concepts, then cite the cleaner direct formulation if found.
7. For fit-into-broader-map questions, the broader-map source must be a core concept-map source that directly relates the target concepts, not only a generic boundary or adjacent-topic source. For `duše`/`duch` mapping, explicitly search for direct relation formulations such as `duch je`, `duše je`, `pozorovatel`, `osobnost`, `ten, kdo se dívá`, `prožívá`, `stejný materiál`, or `funkce`, and prefer a source that states both sides of the relation over a source that merely mentions spiritual/psychological areas.
8. Inspect full context for the strongest evidence using `get_chunk_window`; do not cite from snippets alone. Inspect at least one strongest non-duplicate candidate from each central candidate-source bucket before drafting.
9. Select final sources by semantic relevance and claim coverage, not by retrieval rank alone. If a lower-ranked source is the strongest bridge between related concepts, inspect and use it; if a source is merely repetitive, merge it into its duplicate cluster instead of letting repeated sources crowd out distinct meaning buckets.
10. Before drafting, build a final source plan from ledger variables. For every central bucket that will be used in the synthesis, select the exact source row, full chunk ID, full audio hash, timestamp range, and short exact quote that will appear in the final References section. Prefer quotes that contain the key bridge terms in the same sentence or adjacent sentence, such as the two concepts being related plus the relation word/metaphor; if a nearby quote is eloquent but omits the bridge terms, keep it only as secondary support. For negative or contrast claims, preserve both sides of the contrast in the quote plan, for example the sameness clause and the difference/function clause. Do not rely on a bucket in the synthesis if it has no planned final reference.
11. After collecting evidence, call `llm_query` at least once to critique the interpretation, identify gaps or contradictions, and propose a grounded outline.
12. Before `SUBMIT`, print a compact evidence summary with searches_run, search_queries, unique_chunks, unique_audio_hashes, inspected_windows, llm_query_calls, candidate_source_buckets, duplicate_clusters, main_claims, and final_source_plan.
13. If the evidence is narrow, say so directly instead of overstating coverage.

Before `SUBMIT`:
- Do not submit until you have printed the compact evidence summary.
- Keep transcript context in Python variables. Do not print long transcript windows or repeated excerpts; print only compact source rows, short exact quotes, bucket names, and rejection reasons needed for verification.
- If unique_chunks < 5 or unique_audio_hashes < 2, explain why the evidence is narrow.
- For every central claim, either attach an exact Czech quote from an inspected window or mark the claim as unsupported and do not use it as a finding. Before finalizing each quote, verify that it directly supports the claim text; replace indirect nearby quotes with the shortest exact bridge phrase that preserves the key Czech terms. Never use `...` or other ellipses inside exact quotes; if the source sentence is noisy or too long, quote a shorter contiguous span and explain omissions outside the quoted text. If the claim says two things are not simply identical or not simply separate, include the exact wording for both the similarity/material side and the distinction/function side.
- If planned quotes come from noisy transcript text or near duplicates, compare the duplicate variants before finalizing and use the clearest exact quote. If the selected quote still lacks a concise bridge phrase, search again for the discovered role/function terms and both concepts instead of settling for a broad paraphrase.
- Cross-check that final references still cover every central candidate-source bucket used in the synthesis. If two references are near duplicates, keep the duplicate note but do not let them replace a distinct bucket.
- For fit-into-broader-map questions, require both sides in the final source plan: at least one source for the local usage being explained and at least one distinct core concept-map source for the broader map it is being fitted into. The broader-map quote must directly express the mapped roles or relation, preferably with both sides in one sentence or a tight adjacent pair; if the source role is right but the quote is indirect, inspect/search again before drafting. Do not let a generic spiritual/psychological boundary source replace the direct broader relation source.
- For identity/translation questions, audit non-interchangeable bucket coverage before drafting: direct lexical equivalence, lived self-experience, universal/substance relation, and caveat buckets each need their own final reference if the synthesis uses that claim. The lived self-experience reference must be a dense bridge to `duše`/`individuální duše` or multiple queried identity terms; do not count an isolated `pocit já` plus a separate Atman/Brahman source as coverage for that bucket. Before marking the lived-self bucket satisfied, compare at least two non-duplicate lived-self candidates when available; a lexical-equivalence or caveat source is not a substitute unless it also ties lived self directly back to soul, individual soul, or multiple queried identity terms.
- For body-in-relation questions, audit that an embodiment/expression/manifestation bucket remains present when the synthesis says body expresses, manifests, reveals, or physically presents soul. Do not replace it with only a same-material, celistvost, sensory, or role/function source.
- Audit the final source plan as a bucket checklist: direct definition, direct bridge, role/function contrast, shared-material/celistvost, embodiment/expression/mediation, caveat/ambiguity, and metaphor buckets when used.
- Run a final coverage audit from ledger variables: every central bucket used in the synthesis must have at least one full reference entry and at least one exact quote in that reference. If the audit finds a missing bucket or quote, inspect/search again or remove that claim from the synthesis.
- In the final References section, preserve chunkId, audioHash, timestamp range, exact Czech quote, supported claim, and duplicate/near-duplicate note when applicable. Write timestamps in a machine-readable form such as `startSec: 123.45, endSec: 180.00` or plain `123.45-180.00 s`; do not split the two timestamp numbers into separate backticked fragments.
- Build final references from ledger variables instead of retyping identifiers by hand. Never truncate chunk IDs or audio hashes, never use prefix-only hashes, and never use ellipses inside identifiers.
- Every citation in the final answer must come from the evidence ledger.
""".strip()

_SIGNATURE_INPUTS = [
    SignatureFieldSpec(
        "query",
        str,
        "What information to gather from the Besedy catalog.",
    )
]
_SIGNATURE_OUTPUTS = [
    SignatureFieldSpec(
        "answer",
        str,
        "Comprehensive Czech markdown research report.",
    )
]
BesedyDeepSearchSignature = build_task_signature(
    name="BesedyDeepSearchSignature",
    instructions=BASE_BESEDY_DEEP_SEARCH_INSTRUCTIONS,
    inputs=_SIGNATURE_INPUTS,
    outputs=_SIGNATURE_OUTPUTS,
)


def build_besedy_deep_search_signature(
    instructions: str | None = None,
) -> type[dspy.Signature]:
    """Build the Besedy signature with optional request-specific instructions."""

    instruction_text = _string_or_none(instructions)
    if instruction_text is None:
        return BesedyDeepSearchSignature
    combined_instructions = (
        f"{BASE_BESEDY_DEEP_SEARCH_INSTRUCTIONS}\n\n"
        f"Additional task instructions:\n{instruction_text}"
    )
    suffix = sha256(combined_instructions.encode("utf-8")).hexdigest()[:12]
    return build_task_signature(
        name=f"BesedyDeepSearchSignature_{suffix}",
        instructions=combined_instructions,
        inputs=_SIGNATURE_INPUTS,
        outputs=_SIGNATURE_OUTPUTS,
    )


@contextmanager
def active_task(task_id: str) -> Iterator[None]:
    """Expose the active task to its bound DSPy tools."""

    token = _ACTIVE_TASK_ID.set(str(task_id))
    try:
        yield
    finally:
        _ACTIVE_TASK_ID.reset(token)


def build_besedy_deep_search_tools(
    *,
    client: DeepSearchClient,
    task_context_by_id: Mapping[str, JsonDict],
) -> list[dspy.Tool]:
    """Build the three Besedy retrieval tools used by an RLM task."""

    task_contexts = {str(task_id): dict(payload) for task_id, payload in task_context_by_id.items()}
    seen_windows_by_task: dict[str, set[tuple[str, int]]] = {}

    def current_context() -> JsonDict:
        task_id = _ACTIVE_TASK_ID.get()
        if task_id is None:
            raise RuntimeError("No active Besedy deep-search task.")
        context = task_contexts.get(task_id)
        if context is None:
            raise RuntimeError(f"Unknown Besedy deep-search task: {task_id}")
        return {"task_id": task_id, **context}

    def search_catalog(
        query: str,
        top_k: int | None = None,
        include_neighbors: bool | None = None,
        neighbor_count: int | None = None,
    ) -> JsonDict:
        """Search the current Besedy catalog for additional evidence."""

        context = current_context()
        retrieval = _as_object(context.get("retrieval"))
        configured_top_k = _resolve_top_k(None, retrieval)
        resolved_top_k = _resolve_top_k(top_k, retrieval)
        resolved_include_neighbors = _resolve_include_neighbors(include_neighbors, retrieval)
        resolved_neighbor_count = _resolve_neighbor_count(
            neighbor_count,
            retrieval,
            default=DEFAULT_SEARCH_NEIGHBOR_COUNT,
            maximum=MAX_SEARCH_NEIGHBOR_COUNT,
        )
        response = _call_with_retry(
            lambda: client.search_catalog(
                catalog_id=str(context["catalog_id"]),
                query=query,
                top_k=resolved_top_k,
                include_neighbors=resolved_include_neighbors,
                neighbor_count=(resolved_neighbor_count if resolved_include_neighbors else 0),
            )
        )
        if (
            isinstance(top_k, int)
            and not isinstance(top_k, bool)
            and resolved_top_k < configured_top_k
        ):
            return _with_warning(
                response,
                f"top_k={resolved_top_k} is below configured default "
                f"top_k={configured_top_k}. Use this only for targeted verification "
                "and compensate with follow-up inspection.",
            )
        return response

    def get_chunk_window(chunk_id: str, neighbor_count: int | None = None) -> JsonDict:
        """Fetch a chunk and its neighboring transcript context."""

        context = current_context()
        window = _as_object(context.get("window"))
        resolved_neighbor_count = _resolve_neighbor_count(
            neighbor_count,
            window,
            default=DEFAULT_WINDOW_NEIGHBOR_COUNT,
            maximum=MAX_WINDOW_NEIGHBOR_COUNT,
        )
        window_key = (str(chunk_id), resolved_neighbor_count)
        seen_windows = seen_windows_by_task.setdefault(str(context["task_id"]), set())
        repeated = window_key in seen_windows
        seen_windows.add(window_key)
        response = _call_with_retry(
            lambda: client.get_chunk_window(
                catalog_id=str(context["catalog_id"]),
                chunk_id=chunk_id,
                neighbor_count=resolved_neighbor_count,
            )
        )
        if repeated:
            return _with_warning(
                response,
                f"chunk window {chunk_id!r} with neighbor_count={resolved_neighbor_count} "
                "was already fetched in this run. Reuse the existing variable unless you "
                "need to verify freshness.",
            )
        return response

    def get_metadata(audio_hash: str) -> JsonDict:
        """Fetch recording metadata for an audio hash."""

        context = current_context()
        return _call_with_retry(
            lambda: client.get_metadata(
                catalog_id=str(context["catalog_id"]),
                audio_hash=audio_hash,
            )
        )

    return [
        dspy.Tool(
            search_catalog,
            name="search_catalog",
            desc=(
                "Search the current Besedy catalog for additional evidence. "
                "Args: query (str), top_k (int, optional), include_neighbors (bool, optional), "
                "neighbor_count (int, optional). Defaults are top_k=200, include_neighbors=true, "
                "neighbor_count=1 unless the task config says otherwise. Do not override these "
                "parameters unless you have a good reason, such as a very targeted verification "
                "search or intentionally broad exploration. Use the default top_k for broad "
                "evidence gathering; if you pass top_k below the default, print why and "
                "compensate with follow-up inspection. Each chunk is about 180-260 tokens "
                "(median about 246 tokens, about 82 seconds of transcript), and neighbor_count=1 "
                "adds one chunk before and one chunk after each hit. Returns a JSON object with "
                "retrieval metadata and `results`. Result entries use camelCase keys such as "
                "`chunkId`, `audioHash`, `startSec`, `endSec`, `text`, `contextText`, "
                "`neighbors`, `metadata`, and `citation`. Do not cite from snippets alone; "
                "use `contextText` or `get_chunk_window` for claims you cite."
            ),
        ),
        dspy.Tool(
            get_chunk_window,
            name="get_chunk_window",
            desc=(
                "Fetch one Besedy chunk plus structured neighboring transcript context. "
                "Args: chunk_id (str), neighbor_count (int, optional). Default neighbor_count=1 "
                "unless the task config says otherwise; do not override it unless the current "
                "chunk needs less or more local context. Each chunk is about 180-260 tokens "
                "(median about 246 tokens, about 82 seconds of transcript). Returns a JSON "
                "object with `chunk`, `neighbors`, `contextText`, `metadata`, and `citation`. "
                "`neighbors` is an object with `before` and `after` lists, not a flat list. "
                "For simple reading, prefer `contextText`. Avoid fetching the same chunk window "
                "repeatedly; assign the result to a variable and reuse it."
            ),
        ),
        dspy.Tool(
            get_metadata,
            name="get_metadata",
            desc=(
                "Fetch curated recording metadata for an audio hash in the current catalog. "
                "Args: audio_hash (str). Returns a JSON object with `metadata`."
            ),
        ),
    ]


def _call_with_retry(operation: Callable[[], JsonDict]) -> JsonDict:
    for attempt in range(3):
        try:
            return operation()
        except DeepSearchClientError as exc:
            if attempt == 2 or exc.status_code not in {429, 502, 503, 504}:
                raise DeepSearchClientError(
                    f"{exc} (HTTP {exc.status_code})",
                    status_code=exc.status_code,
                    payload=exc.payload,
                ) from exc
            time.sleep(1)
    raise AssertionError("unreachable")


def _resolve_top_k(value: int | None, config: JsonDict) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    configured = config.get("top_k")
    if isinstance(configured, int) and not isinstance(configured, bool) and configured > 0:
        return configured
    return DEFAULT_RETRIEVAL_TOP_K


def _resolve_include_neighbors(value: bool | None, config: JsonDict) -> bool:
    if isinstance(value, bool):
        return value
    configured = config.get("include_neighbors")
    if isinstance(configured, bool):
        return configured
    return DEFAULT_SEARCH_INCLUDE_NEIGHBORS


def _resolve_neighbor_count(
    value: int | None,
    config: JsonDict,
    *,
    default: int,
    maximum: int,
) -> int:
    candidate: object = value if value is not None else config.get("neighbor_count")
    if isinstance(candidate, int) and not isinstance(candidate, bool) and candidate >= 0:
        return min(candidate, maximum)
    return default


def _as_object(value: object) -> JsonDict:
    return coerce_json_dict(value)


def _with_warning(response: JsonDict, warning: str) -> JsonDict:
    output = dict(response)
    existing = output.get("_warnings")
    output["_warnings"] = [*existing, warning] if isinstance(existing, list) else [warning]
    return output


def _string_or_none(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
