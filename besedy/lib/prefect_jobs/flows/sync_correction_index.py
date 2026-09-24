"""Prefect flow that carries a transcript correction into the search index.

ADR 0006 makes publication prove replacement in the active search scope
before readers see the corrected text. The web application renders the
artifacts and writes the index pointer, then asks this flow to run the
incremental ColBERT sync for the recording. The flow reports back what the
active bundle's source state now says about that recording, and only then
does the web application move its database pointers. Withdrawal from search
and rollback change what the index should hold as well, so they run through
the same flow with a different ``operation``.

The flow runs on the host ingest worker, next to the pipeline, because the
sync needs the same Docker and GPU access and the same transcript tree.
"""

from __future__ import annotations

import json
from pathlib import Path

from prefect import flow, task

from besedy.lib.internal_ingest_client import (
    CorrectionIndexSyncReport,
    CorrectionIndexSyncStatus,
    build_besedy_ingest_client_from_env,
)
from besedy.lib.rag_bundle import resolve_colbert_bundle_artifacts
from besedy.lib.rag_colbert_source_state import read_source_state

from ..json_types import JsonDict
from ..models import (
    validate_audio_hash,
    validate_catalog_id,
    validate_correction_index_operation,
    validate_operation_token,
)
from .ingest_recording import MAX_ERROR_MESSAGE_LENGTH, IngestFlowError, run_catalog_cli

SYNC_STAGE = "rag_colbert_index"


class CorrectionIndexFlowError(IngestFlowError):
    """A sync that ran but left the index in a state the web app must not accept."""


def parse_trailing_json(output: str) -> JsonDict:
    """Return the last JSON object printed by a ``--json`` CLI run.

    The command streams progress from the ColBERT worker before its result, so
    the JSON is found by trying each line that opens an object, last first.
    """
    lines = output.splitlines()
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].strip() != "{":
            continue
        candidate = "\n".join(lines[index:])
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise CorrectionIndexFlowError(
        "The index sync printed no JSON result.", error_code="index_result_missing"
    )


@task
def sync_recording(catalog_id: str, audio_hash: str) -> JsonDict:
    """Run the incremental sync for one recording in the active search scope."""
    output = run_catalog_cli(
        ["rag-colbert-index", "--group", catalog_id, "--hash", audio_hash, "--json"],
        stage=SYNC_STAGE,
        capture_output=True,
    )
    return parse_trailing_json(output or "")


@task
def read_indexed_source(index_dir: str, audio_hash: str) -> JsonDict | None:
    """What the active bundle now records for this recording, or None if absent."""
    artifacts = resolve_colbert_bundle_artifacts(Path(index_dir))
    rows = read_source_state(artifacts.source_state_path, read_only=True)
    row = rows.get(audio_hash)
    if row is None:
        return None
    return {
        "transcriptPath": row.transcript_path,
        "transcriptFingerprint": row.transcript_fingerprint,
    }


@task(retries=3, retry_delay_seconds=[5, 15, 45])
def report_index_sync(report: CorrectionIndexSyncReport) -> JsonDict:
    client = build_besedy_ingest_client_from_env()
    return client.report_correction_index_sync(report=report)


@flow(name="sync_correction_index_flow", log_prints=True)
def sync_correction_index_flow(
    catalog_id: str,
    audio_hash: str,
    operation: str,
    operation_token: str,
    requested_by_id: str | None = None,
) -> JsonDict:
    del requested_by_id
    catalog_id = validate_catalog_id(catalog_id)
    audio_hash = validate_audio_hash(audio_hash)
    operation = validate_correction_index_operation(operation)
    operation_token = validate_operation_token(operation_token)

    try:
        result = sync_recording(catalog_id, audio_hash)
        index_dir = str(result.get("index_dir") or "")
        if not index_dir:
            raise CorrectionIndexFlowError(
                "The index sync reported no bundle directory.",
                error_code="index_result_missing",
            )
        indexed = read_indexed_source(index_dir, audio_hash)
        if indexed is None and operation == "publish":
            raise CorrectionIndexFlowError(
                "The active bundle carries no source for this recording after the sync.",
                error_code="index_source_missing",
            )
        report = CorrectionIndexSyncReport(
            catalog_id=catalog_id,
            audio_hash=audio_hash,
            operation=operation,
            operation_token=operation_token,
            status=CorrectionIndexSyncStatus.SUCCEEDED,
            transcript_fingerprint=indexed["transcriptFingerprint"] if indexed else None,
            transcript_path=indexed["transcriptPath"] if indexed else None,
            index_dir=index_dir,
        )
    except Exception as exc:
        failure = CorrectionIndexSyncReport(
            catalog_id=catalog_id,
            audio_hash=audio_hash,
            operation=operation,
            operation_token=operation_token,
            status=CorrectionIndexSyncStatus.FAILED,
            error_code=getattr(exc, "error_code", None) or "index_sync_failed",
            error_message=str(exc)[:MAX_ERROR_MESSAGE_LENGTH],
        )
        try:
            report_index_sync(failure)
        except Exception as report_exc:  # pragma: no cover - defensive runtime guard
            print(f"Failed to report index sync failure for {audio_hash}: {report_exc}")
        raise

    report_index_sync(report)
    return report.to_payload()
