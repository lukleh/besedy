from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

pytestmark = [pytest.mark.optional_dependency, pytest.mark.jobs]
pytest.importorskip("prefect", reason="requires the optional jobs extra")

from besedy.lib.prefect_jobs import deploy as deploy_module  # noqa: E402
from besedy.lib.prefect_jobs.api import PrefectJobsApiService, create_handler  # noqa: E402
from besedy.lib.prefect_jobs.models import (  # noqa: E402
    JobStatus,
    normalize_flow_run,
    prefect_state_names_for_job_status,
    prefect_state_to_job_status,
)

CATALOG_ID = "20260201_120000"
INTAKE_ID = "cmf9abcdefghijklmnopqrstu"


def _request_json(
    method: str,
    url: str,
    payload: dict | None = None,
    *,
    bearer_token: str | None = None,
) -> dict:
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if bearer_token is not None:
        headers["Authorization"] = f"Bearer {bearer_token}"
    request = Request(url, data=body, method=method, headers=headers)
    with urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


class FakePrefectClient:
    def __init__(self) -> None:
        now = datetime.now(UTC)
        self.flow_run_id = str(uuid4())
        self.read_flow_runs_calls: list[dict[str, object]] = []
        self.states = [
            SimpleNamespace(name="Scheduled", type="SCHEDULED", message=None, timestamp=now),
            SimpleNamespace(name="Running", type="RUNNING", message=None, timestamp=now),
        ]
        self.flow_run = SimpleNamespace(
            id=self.flow_run_id,
            created=now,
            updated=now,
            start_time=now,
            end_time=None,
            state_name="Scheduled",
            state_type="SCHEDULED",
            deployment_id=str(uuid4()),
            work_pool_name="besedy-ingest",
            parameters={
                "catalog_id": CATALOG_ID,
                "intake_id": INTAKE_ID,
                "original_filename": "talk.mp3",
                "requested_by_id": "admin-1",
            },
            state=SimpleNamespace(message=None),
            tags=["job-kind:ingest", f"catalog:{CATALOG_ID}", "requested-by:admin-1"],
        )
        self.submit_calls: list[dict[str, object]] = []
        self.cancelled = False

    def create_deployment_run(
        self,
        *,
        deployment_name: str,
        parameters: dict[str, object],
        flow_run_name: str,
        tags: list[str],
        idempotency_key: str | None = None,
    ) -> object:
        self.submit_calls.append(
            {
                "deployment_name": deployment_name,
                "parameters": parameters,
                "flow_run_name": flow_run_name,
                "tags": tags,
                "idempotency_key": idempotency_key,
            }
        )
        self.flow_run.parameters = parameters
        self.flow_run.tags = tags
        self.flow_run.state_name = "Scheduled"
        self.flow_run.state_type = "SCHEDULED"
        return self.flow_run

    def read_flow_run(self, *, flow_run_id: str) -> object:
        if flow_run_id != self.flow_run_id:
            raise FileNotFoundError(f"Unknown flow run: {flow_run_id}")
        return self.flow_run

    def read_flow_runs(
        self,
        *,
        tags: list[str],
        limit: int,
        state_names: list[str] | None = None,
    ) -> list[object]:
        self.read_flow_runs_calls.append({"tags": tags, "limit": limit, "state_names": state_names})
        runs = [self.flow_run]
        filtered = []
        for run in runs:
            run_tags = list(getattr(run, "tags", []) or [])
            if tags and not all(tag in run_tags for tag in tags):
                continue
            if state_names and str(getattr(run, "state_name", "")) not in state_names:
                continue
            filtered.append(run)
        return filtered[:limit]

    def read_flow_run_states(self, *, flow_run_id: str) -> list[object]:
        if flow_run_id != self.flow_run_id:
            raise FileNotFoundError(f"Unknown flow run: {flow_run_id}")
        return list(self.states)

    def cancel_flow_run(self, *, flow_run_id: str) -> object:
        if flow_run_id != self.flow_run_id:
            raise FileNotFoundError(f"Unknown flow run: {flow_run_id}")
        self.cancelled = True
        self.flow_run.state_name = "Cancelling"
        self.flow_run.state_type = "CANCELLING"
        self.flow_run.state = SimpleNamespace(message="Cancellation requested.")
        self.states.append(
            SimpleNamespace(
                name="Cancelling",
                type="CANCELLING",
                message="Cancellation requested.",
                timestamp=datetime.now(UTC),
            )
        )
        return SimpleNamespace(status="ACCEPT")


def test_prefect_state_mapping() -> None:
    assert prefect_state_to_job_status("Scheduled", "SCHEDULED") == JobStatus.QUEUED
    assert prefect_state_to_job_status("Running", "RUNNING") == JobStatus.RUNNING
    assert prefect_state_to_job_status("Completed", "COMPLETED") == JobStatus.SUCCEEDED
    assert prefect_state_to_job_status("Cancelled", "CANCELLED") == JobStatus.CANCELLED
    assert prefect_state_to_job_status("Failed", "FAILED") == JobStatus.FAILED


def test_prefect_state_name_mapping() -> None:
    assert prefect_state_names_for_job_status(JobStatus.QUEUED) == ["Scheduled", "Pending", "Late"]
    assert prefect_state_names_for_job_status(JobStatus.RUNNING) == [
        "Running",
        "Cancelling",
        "Paused",
    ]
    assert prefect_state_names_for_job_status(JobStatus.SUCCEEDED) == ["Completed"]
    assert prefect_state_names_for_job_status(JobStatus.FAILED) == ["Failed", "Crashed", "TimedOut"]
    assert prefect_state_names_for_job_status(JobStatus.CANCELLED) == ["Cancelled"]


@pytest.fixture
def jobs_server(monkeypatch):
    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
    client = FakePrefectClient()
    service = PrefectJobsApiService(
        client=client,
        ingest_deployment_name="ingest_recording_flow/ingest-test",
        prefect_ui_url="http://prefect.example",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield client, service, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_prefect_jobs_service_http_round_trip(jobs_server) -> None:
    client, _service, base_url = jobs_server
    created = _request_json(
        "POST",
        f"{base_url}/catalogs/{CATALOG_ID}/ingest/jobs",
        {"intakeId": INTAKE_ID, "originalFilename": "talk.mp3", "requestedById": "admin-1"},
        bearer_token="jobs-secret",
    )
    assert created["id"] == client.flow_run_id
    assert created["kind"] == "INGEST"
    assert client.submit_calls[0]["deployment_name"] == "ingest_recording_flow/ingest-test"

    listed = _request_json(
        "GET", f"{base_url}/jobs?catalogId={CATALOG_ID}", bearer_token="jobs-secret"
    )
    assert [job["id"] for job in listed["jobs"]] == [client.flow_run_id]

    detail = _request_json(
        "GET", f"{base_url}/jobs/{client.flow_run_id}", bearer_token="jobs-secret"
    )
    assert detail["payload"]["originalFilename"] == "talk.mp3"
    history = _request_json(
        "GET", f"{base_url}/jobs/{client.flow_run_id}/history", bearer_token="jobs-secret"
    )
    assert [event["stateName"] for event in history["events"]] == ["Scheduled", "Running"]
    assert history["prefectUiUrl"].endswith(client.flow_run_id)
    assert history["artifacts"] == []

    cancelled = _request_json(
        "POST", f"{base_url}/jobs/{client.flow_run_id}/cancel", bearer_token="jobs-secret"
    )
    assert cancelled["status"] == JobStatus.RUNNING.value
    assert client.cancelled is True


def test_prefect_jobs_service_health_does_not_require_bearer_token(
    jobs_server, monkeypatch
) -> None:
    _client, _service, base_url = jobs_server
    monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET")
    assert _request_json("GET", f"{base_url}/health")["ready"] is True


@pytest.mark.parametrize(
    ("secret", "authorization"),
    [("jobs-secret", None), ("jobs-secret", "Bearer wrong-secret"), (None, "Bearer jobs-secret")],
)
def test_prefect_jobs_service_requires_bearer_token(
    jobs_server, monkeypatch, secret, authorization
) -> None:
    _client, _service, base_url = jobs_server
    if secret is None:
        monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET")
    else:
        monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", secret)
    headers = {"Authorization": authorization} if authorization else {}
    with pytest.raises(HTTPError) as error:
        urlopen(Request(f"{base_url}/jobs", headers=headers), timeout=5)
    assert error.value.code == 401


def test_prefect_jobs_service_rejects_malformed_json(jobs_server) -> None:
    client, _service, base_url = jobs_server
    request = Request(
        f"{base_url}/catalogs/{CATALOG_ID}/ingest/jobs",
        data=b"not JSON",
        method="POST",
        headers={"Authorization": "Bearer jobs-secret", "Content-Type": "application/json"},
    )
    with pytest.raises(HTTPError) as error:
        urlopen(request, timeout=5)
    assert error.value.code == 400
    assert client.submit_calls == []


def test_removed_job_submission_route_is_not_available(jobs_server) -> None:
    client, _service, base_url = jobs_server
    with pytest.raises(HTTPError) as error:
        _request_json(
            "POST",
            f"{base_url}/catalogs/{CATALOG_ID}/deep-search/jobs",
            {},
            bearer_token="jobs-secret",
        )
    assert error.value.code == 404
    assert client.submit_calls == []


@pytest.mark.parametrize(
    "tags",
    [
        [],
        ["job-kind:deep-search"],
        ["job-kind:unknown"],
        ["job-kind:ingest", "job-kind:deep-search"],
    ],
)
def test_unsupported_runs_are_hidden_and_cannot_be_cancelled(jobs_server, tags) -> None:
    client, service, base_url = jobs_server
    client.flow_run.tags = tags
    assert service.list_jobs(raw_query="kind=INGEST")["jobs"] == []
    with pytest.raises(FileNotFoundError, match="Unsupported job kind"):
        normalize_flow_run(client.flow_run)
    for method, suffix in [("GET", ""), ("GET", "/history"), ("POST", "/cancel")]:
        with pytest.raises(HTTPError) as error:
            _request_json(
                method,
                f"{base_url}/jobs/{client.flow_run_id}{suffix}",
                bearer_token="jobs-secret",
            )
        assert error.value.code == 404
    assert client.cancelled is False


def test_list_jobs_sanitizes_tags_and_passes_status_filter() -> None:
    client = FakePrefectClient()
    client.flow_run.tags = ["job-kind:ingest", "catalog:catalog-1", "requested-by:admin-1"]
    client.flow_run.state_name = "Failed"
    client.flow_run.state_type = "FAILED"
    service = PrefectJobsApiService(client=client)
    jobs = service.list_jobs(
        raw_query="catalogId=Catalog%201&requestedById=Admin%201&status=FAILED"
    )
    assert [job["id"] for job in jobs["jobs"]] == [client.flow_run_id]
    assert client.read_flow_runs_calls == [
        {
            "tags": ["job-kind:ingest", "catalog:catalog-1", "requested-by:admin-1"],
            "limit": 50,
            "state_names": ["Failed", "Crashed", "TimedOut"],
        }
    ]
    with pytest.raises(ValueError, match="Unsupported kind"):
        service.list_jobs(raw_query="kind=DEEP_SEARCH")


def test_deploy_cli_registers_only_host_maintenance_deployments(monkeypatch) -> None:
    ensured = []
    deployments = []
    applied = []

    class Client:
        def ensure_process_work_pool(self, **kwargs):
            ensured.append(kwargs)

    class Deployment:
        def apply(self, **kwargs):
            applied.append(kwargs)

    class Flow:
        def to_deployment(self, **kwargs):
            deployments.append(kwargs)
            return Deployment()

    monkeypatch.setattr(deploy_module, "RuntimePrefectJobsClient", Client)
    for name in ("ingest_recording_flow", "remove_recording_flow", "sync_correction_index_flow"):
        monkeypatch.setattr(deploy_module, name, Flow())
    assert (
        deploy_module.main(
            [
                "--ingest-work-pool",
                "ingest-test",
                "--ingest-deployment-name",
                "ingest",
                "--ingest-remove-deployment-name",
                "remove",
                "--correction-index-deployment-name",
                "correction",
                "--ingest-concurrency-limit",
                "0",
            ]
        )
        == 0
    )
    assert ensured == [{"name": "ingest-test", "concurrency_limit": 1}]
    assert [item["name"] for item in deployments] == ["ingest", "remove", "correction"]
    assert [item["tags"] for item in deployments] == [
        ["job-kind:ingest"],
        ["job-kind:ingest"],
        ["job-kind:correction-index"],
    ]
    assert all(item["work_pool_name"] == "ingest-test" for item in deployments)
    assert all(item["concurrency_limit"] == 1 for item in deployments)
    assert all(
        item["entrypoint_type"] == deploy_module.EntrypointType.MODULE_PATH for item in deployments
    )
    assert applied == [{"work_pool_name": "ingest-test"}] * 3


@pytest.mark.parametrize("secret", ["", "   "])
def test_jobs_server_refuses_to_start_with_an_empty_service_secret(
    monkeypatch, capsys, secret: str
) -> None:
    from besedy.lib.prefect_jobs import server as server_module

    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", secret)
    served: list[dict[str, object]] = []
    monkeypatch.setattr(
        server_module, "serve_threading_http_server", lambda **kwargs: served.append(kwargs)
    )

    assert server_module.main(["--port", "0"]) == 1
    assert served == []
    assert "BESEDY_JOB_SERVICE_SECRET is empty" in capsys.readouterr().err


def test_jobs_server_starts_with_a_configured_service_secret(monkeypatch) -> None:
    from besedy.lib.prefect_jobs import server as server_module

    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
    served: list[dict[str, object]] = []
    monkeypatch.setattr(
        server_module, "serve_threading_http_server", lambda **kwargs: served.append(kwargs)
    )
    monkeypatch.setattr(server_module, "PrefectJobsApiService", lambda: FakePrefectClient())

    assert server_module.main(["--host", "127.0.0.1", "--port", "0"]) == 0
    assert len(served) == 1
    assert served[0]["host"] == "127.0.0.1"
    assert served[0]["port"] == 0
