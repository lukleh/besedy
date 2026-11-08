from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from besedy.lib.prefect_jobs.models import (
    CorrectionIndexSyncRequest,
    IngestRemovalRequest,
    IngestSubmitRequest,
    require_archive_id,
    validate_catalog_id,
    validate_deployment_catalog_id,
)

ARCHIVE = "20251225_120000"
FOREIGN = "20260101_120000"


@pytest.mark.parametrize(
    "value", [None, "", "   ", "latest", "../20251225_120000", "20251225_120000/extra"]
)
def test_missing_or_invalid_binding_fails_before_job_parameters(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    if value is None:
        monkeypatch.delenv("BESEDY_ARCHIVE_ID", raising=False)
    else:
        monkeypatch.setenv("BESEDY_ARCHIVE_ID", value)
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        require_archive_id()
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        validate_deployment_catalog_id(ARCHIVE)
    for request in _requests():
        with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
            request.to_flow_parameters(catalog_id=ARCHIVE)


def test_binding_is_explicit_and_does_not_change_general_catalog_validation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("BESEDY_ARCHIVE_ID", raising=False)
    assert validate_catalog_id(FOREIGN) == FOREIGN
    monkeypatch.setenv("BESEDY_ARCHIVE_ID", f" {ARCHIVE} ")
    assert require_archive_id() == ARCHIVE
    assert validate_deployment_catalog_id(ARCHIVE) == ARCHIVE
    assert validate_catalog_id(FOREIGN) == FOREIGN


def _requests() -> list[IngestSubmitRequest | IngestRemovalRequest | CorrectionIndexSyncRequest]:
    return [
        IngestSubmitRequest("cmf9abcdefghijklmnopqrstu", "talk.wav", "admin"),
        IngestRemovalRequest("cmf9abcdefghijklmnopqrstu", "a" * 64, "x" * 16, "admin"),
        CorrectionIndexSyncRequest(
            "a" * 64, "publish", "00000000-0000-4000-8000-000000000001", "admin"
        ),
    ]


def test_job_requests_cannot_target_a_foreign_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    for request in _requests():
        with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
            request.to_flow_parameters(catalog_id=FOREIGN)
        assert request.to_flow_parameters(catalog_id=ARCHIVE)["catalog_id"] == ARCHIVE


@pytest.mark.optional_dependency
@pytest.mark.jobs
@pytest.mark.parametrize("value", [None, "", "   ", "latest", ARCHIVE])
def test_direct_worker_path_resolution_cannot_bypass_binding(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, value: str | None
) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.flows.ingest_recording import resolve_ingest_paths
    from besedy.lib.prefect_jobs.flows.sync_correction_index import resolve_catalog_transcripts_root

    if value is None:
        monkeypatch.delenv("BESEDY_ARCHIVE_ID", raising=False)
    else:
        monkeypatch.setenv("BESEDY_ARCHIVE_ID", value)
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        resolve_ingest_paths(
            FOREIGN, "cmf9abcdefghijklmnopqrstu", uploads_root=tmp_path, catalogs_root=tmp_path
        )
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        resolve_catalog_transcripts_root(FOREIGN)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.optional_dependency
@pytest.mark.jobs
@pytest.mark.parametrize("value", [None, "", "   ", "latest"])
def test_jobs_facade_refuses_to_start_without_a_valid_binding(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.api import PrefectJobsApiService

    if value is None:
        monkeypatch.delenv("BESEDY_ARCHIVE_ID", raising=False)
    else:
        monkeypatch.setenv("BESEDY_ARCHIVE_ID", value)
    client = Mock()
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        PrefectJobsApiService(client=client)
    assert client.mock_calls == []


@pytest.mark.optional_dependency
@pytest.mark.jobs
def test_jobs_facade_scopes_list_read_history_and_cancel_to_bound_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.api import PrefectJobsApiService

    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    client = Mock()
    client.read_flow_run.return_value = SimpleNamespace(
        id="00000000-0000-4000-8000-000000000001",
        tags=["job-kind:ingest", f"catalog:{ARCHIVE}"],
        parameters={"catalog_id": FOREIGN},
        state_name="Running",
        state_type="RUNNING",
    )
    service = PrefectJobsApiService(client=client)
    job_id = "00000000-0000-4000-8000-000000000001"
    for operation in (service.get_job, service.get_history, service.cancel_job):
        with pytest.raises(FileNotFoundError, match="Job not found"):
            operation(job_id=job_id)
    client.read_flow_run_states.assert_not_called()
    client.cancel_flow_run.assert_not_called()
    client.read_flow_runs.return_value = [client.read_flow_run.return_value]
    assert service.list_jobs(raw_query="")["jobs"] == []
    assert client.read_flow_runs.call_args.kwargs["tags"] == [
        "job-kind:ingest",
        f"catalog:{ARCHIVE}",
    ]
    client.read_flow_runs.reset_mock()
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        service.list_jobs(raw_query=f"catalogId={FOREIGN}")
    client.read_flow_runs.assert_not_called()


@pytest.mark.optional_dependency
@pytest.mark.jobs
@pytest.mark.parametrize(
    ("method", "payload"),
    [
        (
            "submit_ingest",
            {
                "intakeId": "cmf9abcdefghijklmnopqrstu",
                "originalFilename": "talk.wav",
                "requestedById": "admin",
            },
        ),
        (
            "submit_ingest_removal",
            {
                "intakeId": "cmf9abcdefghijklmnopqrstu",
                "audioHash": "a" * 64,
                "idempotencyKey": "x" * 16,
                "requestedById": "admin",
            },
        ),
        (
            "submit_correction_index_sync",
            {
                "audioHash": "a" * 64,
                "operation": "publish",
                "operationToken": "00000000-0000-4000-8000-000000000001",
                "requestedById": "admin",
            },
        ),
    ],
)
def test_foreign_submissions_never_reach_prefect(
    monkeypatch: pytest.MonkeyPatch, method: str, payload: dict[str, str]
) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.api import PrefectJobsApiService

    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    client = Mock()
    service = PrefectJobsApiService(client=client)
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        getattr(service, method)(catalog_id=FOREIGN, payload=payload)
    client.create_deployment_run.assert_not_called()
