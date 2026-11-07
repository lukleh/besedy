from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from besedy.lib.prefect_jobs.models import (
    CorrectionIndexSyncRequest,
    IngestRemovalRequest,
    IngestSubmitRequest,
    get_configured_archive_id,
    validate_deployment_catalog_id,
)

ARCHIVE = "20251225_120000"
FOREIGN = "20260101_120000"


def test_unset_archive_binding_preserves_transitional_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BESEDY_ARCHIVE_ID", raising=False)
    assert get_configured_archive_id() is None
    assert validate_deployment_catalog_id(FOREIGN) == FOREIGN


@pytest.mark.parametrize("value", ["latest", "../20251225_120000", "20251225_120000/extra"])
def test_invalid_binding_fails_before_job_parameters(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("BESEDY_ARCHIVE_ID", value)
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        validate_deployment_catalog_id(ARCHIVE)


def test_job_requests_cannot_target_a_foreign_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    requests = [
        IngestSubmitRequest("cmf9abcdefghijklmnopqrstu", "talk.wav", "admin"),
        IngestRemovalRequest("cmf9abcdefghijklmnopqrstu", "a" * 64, "x" * 16, "admin"),
        CorrectionIndexSyncRequest("a" * 64, "publish", "00000000-0000-4000-8000-000000000001", "admin"),
    ]
    for request in requests:
        with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
            request.to_flow_parameters(catalog_id=FOREIGN)
        assert request.to_flow_parameters(catalog_id=ARCHIVE)["catalog_id"] == ARCHIVE


@pytest.mark.optional_dependency
@pytest.mark.jobs
def test_direct_ingest_flow_path_resolution_cannot_bypass_binding(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.flows.ingest_recording import resolve_ingest_paths

    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    with pytest.raises(ValueError, match="BESEDY_ARCHIVE_ID"):
        resolve_ingest_paths(FOREIGN, "cmf9abcdefghijklmnopqrstu", uploads_root=tmp_path, catalogs_root=tmp_path)
    assert list(tmp_path.iterdir()) == []


@pytest.mark.optional_dependency
@pytest.mark.jobs
def test_jobs_facade_cannot_cancel_a_foreign_job(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.api import PrefectJobsApiService

    monkeypatch.setenv("BESEDY_ARCHIVE_ID", ARCHIVE)
    client = Mock()
    client.read_flow_run.return_value = SimpleNamespace(
        id="00000000-0000-4000-8000-000000000001",
        tags=["job-kind:ingest"],
        parameters={"catalog_id": FOREIGN},
        state_name="Running",
        state_type="RUNNING",
    )
    service = PrefectJobsApiService(client=client)
    with pytest.raises(FileNotFoundError, match="Job not found"):
        service.cancel_job(job_id="00000000-0000-4000-8000-000000000001")
    client.cancel_flow_run.assert_not_called()
