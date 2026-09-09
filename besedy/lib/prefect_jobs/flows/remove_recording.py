"""Prefect flow that removes a web-ingested recording and everything derived from it.

Counterpart of :mod:`ingest_recording`: the same host worker runs the catalog
CLI so the recording leaves the catalog CSVs, its staged/archived audio,
transcripts, diarization and embeddings are deleted, and a follow-up
`run-pipeline` lets the incremental ColBERT sync prune the hash and
`cluster-speakers` rebuild without it. The web app finishes the job by removing
its own rows and re-syncing the projection.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from prefect import flow, task

from besedy.lib.catalog.remover import normalize_audio_hash
from besedy.lib.internal_ingest_client import IngestCompletionStatus

from ..json_types import JsonDict
from .ingest_recording import (
    COMPLETION_REPORT_FAILED_MARKER,
    IngestFlowError,
    IngestPaths,
    _report_failure_best_effort,
    catalog_ingest_lock,
    report_completion,
    resolve_ingest_paths,
    run_catalog_cli,
)


@task
def remove_recording_artifacts(catalog_csv: str, audio_hash: str) -> None:
    run_catalog_cli(
        [
            "remove",
            "--csv",
            catalog_csv,
            "--hash",
            audio_hash,
            "--execute",
            "--delete-source",
            "--format",
            "json",
        ],
        stage="catalog_remove",
    )


@task
def refresh_derived_stores(catalog_csv: str) -> str | None:
    """Prune the RAG index and rebuild speaker clusters; best effort.

    The recording is already gone from the catalog at this point, so a failure
    here must not turn the removal into a failed job - it is reported as a
    warning and the operator can re-run `catalog run-pipeline` by hand.
    """
    try:
        run_catalog_cli(
            ["run-pipeline", "--csv", catalog_csv, "--no-symlink"], stage="run_pipeline"
        )
    except IngestFlowError as exc:
        return str(exc)
    return None


@task
def remove_intake_dirs(paths: list[str]) -> None:
    for raw in paths:
        shutil.rmtree(Path(raw), ignore_errors=True)


def _intake_dirs(paths: IngestPaths) -> list[str]:
    return [str(paths.incoming_dir), str(paths.accepted_dir), str(paths.rejected_dir)]


@flow(name="remove_recording_flow", log_prints=True)
def remove_recording_flow(
    catalog_id: str,
    intake_id: str,
    audio_hash: str,
    requested_by_id: str | None = None,
) -> JsonDict:
    del requested_by_id
    audio_hash = normalize_audio_hash(audio_hash)
    paths = resolve_ingest_paths(catalog_id, intake_id)

    with catalog_ingest_lock(paths.lock_path):
        try:
            remove_recording_artifacts(str(paths.catalog_csv), audio_hash)
            warning = refresh_derived_stores(str(paths.catalog_csv))
            remove_intake_dirs(_intake_dirs(paths))
        except Exception as exc:
            _report_failure_best_effort(paths.intake_id, exc)
            raise

    outcome: JsonDict = {
        "status": IngestCompletionStatus.REMOVED.value,
        "audioHash": audio_hash,
        "errorCode": "derived_refresh_failed" if warning else None,
        "errorMessage": warning,
    }
    try:
        report_completion(paths.intake_id, outcome)
    except Exception as exc:
        raise IngestFlowError(
            f"Completion report failed: {exc}. "
            f"{COMPLETION_REPORT_FAILED_MARKER}{json.dumps(outcome)}",
            error_code="completion_report_failed",
        ) from exc
    return outcome
