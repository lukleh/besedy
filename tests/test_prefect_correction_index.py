"""The correction index sync: request, job facade and flow."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("prefect", reason="requires the optional jobs extra")

from besedy.lib.internal_ingest_client import CorrectionIndexSyncStatus  # noqa: E402
from besedy.lib.prefect_jobs.api import PrefectJobsApiService  # noqa: E402
from besedy.lib.prefect_jobs.flows import sync_correction_index as sync_module  # noqa: E402
from besedy.lib.prefect_jobs.models import (  # noqa: E402
    CorrectionIndexSyncRequest,
    JobKind,
    JobStatus,
    job_kind_from_tags,
    normalize_flow_run,
)
from tests.test_prefect_jobs import FakePrefectClient  # noqa: E402

CATALOG_ID = "20260201_120000"
AUDIO_HASH = "a" * 64
PUBLICATION_ID = str(uuid4())


# --- request ----------------------------------------------------------------


def test_request_validates_operation_and_token() -> None:
    request = CorrectionIndexSyncRequest.from_payload(
        {
            "audioHash": AUDIO_HASH.upper(),
            "operation": "Publish",
            "operationToken": PUBLICATION_ID,
            "requestedById": "curator-1",
            "attempt": 2,
        }
    )
    assert request.audio_hash == AUDIO_HASH
    assert request.operation == "publish"
    assert request.idempotency_key == f"correction-index:publish:{PUBLICATION_ID}:2"
    assert request.to_flow_parameters(catalog_id=CATALOG_ID) == {
        "catalog_id": CATALOG_ID,
        "audio_hash": AUDIO_HASH,
        "operation": "publish",
        "operation_token": PUBLICATION_ID,
        "requested_by_id": "curator-1",
    }

    with pytest.raises(ValueError):
        CorrectionIndexSyncRequest.from_payload(
            {"audioHash": AUDIO_HASH, "operation": "reindex", "operationToken": PUBLICATION_ID}
        )
    with pytest.raises(ValueError):
        CorrectionIndexSyncRequest.from_payload(
            {"audioHash": AUDIO_HASH, "operation": "publish", "operationToken": "not-a-uuid"}
        )
    with pytest.raises(ValueError):
        CorrectionIndexSyncRequest.from_payload(
            {
                "audioHash": AUDIO_HASH,
                "operation": "publish",
                "operationToken": PUBLICATION_ID,
                "attempt": -1,
            }
        )


def test_job_kind_and_normalized_payload(tmp_path: Path) -> None:
    assert job_kind_from_tags(["job-kind:correction-index"]) == JobKind.CORRECTION_INDEX
    now = datetime.now(UTC)
    flow_run = SimpleNamespace(
        id="run-1",
        created=now,
        updated=now,
        start_time=now,
        end_time=None,
        state_name="Running",
        state_type="RUNNING",
        deployment_id=None,
        work_pool_name="besedy-ingest",
        parameters={
            "catalog_id": CATALOG_ID,
            "audio_hash": AUDIO_HASH,
            "operation": "withdraw",
            "operation_token": PUBLICATION_ID,
            "requested_by_id": "admin-1",
        },
        state=SimpleNamespace(message=None),
        tags=["job-kind:correction-index"],
    )
    job = normalize_flow_run(flow_run, output_root_dir=tmp_path)
    assert job["kind"] == "CORRECTION_INDEX"
    assert job["status"] == JobStatus.RUNNING.value
    assert job["payload"] == {
        "audioHash": AUDIO_HASH,
        "operation": "withdraw",
        "operationToken": PUBLICATION_ID,
    }


# --- API facade -------------------------------------------------------------


def test_service_submits_correction_index_sync(tmp_path: Path) -> None:
    fake_client = FakePrefectClient()
    service = PrefectJobsApiService(
        client=fake_client,
        output_root_dir=tmp_path,
        correction_index_deployment_name="sync_correction_index_flow/correction-index-test",
    )

    created = service.submit_correction_index_sync(
        catalog_id=CATALOG_ID,
        payload={
            "audioHash": AUDIO_HASH,
            "operation": "publish",
            "operationToken": PUBLICATION_ID,
            "requestedById": "curator-1",
        },
    )
    assert created["id"] == fake_client.flow_run_id
    submit = fake_client.submit_calls[0]
    assert submit["deployment_name"] == "sync_correction_index_flow/correction-index-test"
    assert submit["idempotency_key"] == f"correction-index:publish:{PUBLICATION_ID}:0"
    assert submit["parameters"]["audio_hash"] == AUDIO_HASH
    assert "job-kind:correction-index" in submit["tags"]
    assert f"recording:{AUDIO_HASH}" in submit["tags"]


# --- flow -------------------------------------------------------------------


def test_parse_trailing_json_skips_worker_chatter() -> None:
    output = "\n".join(
        [
            "[docker] pulling image",
            "{ not json",
            "progress 50%",
            "{",
            '  "index_dir": "/bundles/index",',
            '  "chunk_count": 3',
            "}",
        ]
    )
    assert sync_module.parse_trailing_json(output) == {
        "index_dir": "/bundles/index",
        "chunk_count": 3,
    }
    with pytest.raises(sync_module.CorrectionIndexFlowError):
        sync_module.parse_trailing_json("no result here")


def _run_flow(monkeypatch, *, operation: str, indexed_row):  # type: ignore[no-untyped-def]
    cli_calls: list[list[str]] = []
    reports: list[dict[str, object]] = []

    def fake_cli(args, *, stage, **_kwargs):  # type: ignore[no-untyped-def]
        cli_calls.append([stage, *args])
        return "worker chatter\n" + json.dumps({"index_dir": "/bundles/scope/index"}, indent=2)

    monkeypatch.setattr(sync_module, "run_catalog_cli", fake_cli)
    monkeypatch.setattr(
        sync_module,
        "read_source_state",
        lambda _path, *, read_only=False: (
            {AUDIO_HASH: indexed_row} if indexed_row is not None else {}
        ),
    )
    monkeypatch.setattr(
        sync_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_correction_index_sync=lambda *, report: (
                reports.append(report.to_payload()) or {"ok": True}
            )
        ),
    )
    result = sync_module.sync_correction_index_flow(
        catalog_id=CATALOG_ID,
        audio_hash=AUDIO_HASH,
        operation=operation,
        operation_token=PUBLICATION_ID,
        requested_by_id="curator-1",
    )
    return result, cli_calls, reports


def test_flow_syncs_one_recording_and_reports_what_the_bundle_holds(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    row = SimpleNamespace(
        transcript_path="/corrections/corrections_x/ws/publications/p/transcript.json",
        transcript_fingerprint="f" * 64,
    )
    result, cli_calls, reports = _run_flow(monkeypatch, operation="publish", indexed_row=row)

    assert cli_calls == [
        [
            "rag_colbert_index",
            "rag-colbert-index",
            "--group",
            CATALOG_ID,
            "--hash",
            AUDIO_HASH,
            "--json",
        ]
    ]
    assert len(reports) == 1
    report = reports[0]
    assert report["status"] == CorrectionIndexSyncStatus.SUCCEEDED.value
    assert report["operation"] == "publish"
    assert report["operationToken"] == PUBLICATION_ID
    assert report["transcriptFingerprint"] == "f" * 64
    assert report["transcriptPath"].endswith("/publications/p/transcript.json")
    assert report["indexDir"] == "/bundles/scope/index"
    assert result == report


def test_flow_reports_failure_when_publication_left_no_source(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    with pytest.raises(sync_module.CorrectionIndexFlowError):
        _run_flow(monkeypatch, operation="publish", indexed_row=None)


def test_flow_accepts_a_withdrawn_recording_with_no_source(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    result, _cli_calls, reports = _run_flow(monkeypatch, operation="withdraw", indexed_row=None)
    assert reports[0]["status"] == CorrectionIndexSyncStatus.SUCCEEDED.value
    assert reports[0]["transcriptPath"] is None
    assert result["operation"] == "withdraw"


def test_flow_reports_failure_before_raising(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    reports: list[dict[str, object]] = []

    def failing_cli(args, *, stage, **_kwargs):  # type: ignore[no-untyped-def]
        raise sync_module.IngestFlowError("boom", error_code="rag_colbert_index_failed")

    monkeypatch.setattr(sync_module, "run_catalog_cli", failing_cli)
    monkeypatch.setattr(
        sync_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_correction_index_sync=lambda *, report: (
                reports.append(report.to_payload()) or {"ok": True}
            )
        ),
    )
    with pytest.raises(sync_module.IngestFlowError):
        sync_module.sync_correction_index_flow(
            catalog_id=CATALOG_ID,
            audio_hash=AUDIO_HASH,
            operation="publish",
            operation_token=PUBLICATION_ID,
        )
    assert reports[0]["status"] == CorrectionIndexSyncStatus.FAILED.value
    assert reports[0]["errorCode"] == "rag_colbert_index_failed"
