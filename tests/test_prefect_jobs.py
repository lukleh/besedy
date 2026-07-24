from __future__ import annotations

import json
import tempfile
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("prefect", reason="requires the optional jobs extra")

from besedy.lib.prefect_jobs import deploy as deploy_module  # noqa: E402
from besedy.lib.prefect_jobs import models as models_module  # noqa: E402
from besedy.lib.prefect_jobs import rlm_adapter as rlm_adapter_module  # noqa: E402
from besedy.lib.prefect_jobs import rlm_logs as rlm_logs_module  # noqa: E402
from besedy.lib.prefect_jobs import rlm_runtime as rlm_runtime_module  # noqa: E402
from besedy.lib.prefect_jobs.api import PrefectJobsApiService, create_handler  # noqa: E402
from besedy.lib.prefect_jobs.flows import deep_search as deep_search_flow_module  # noqa: E402
from besedy.lib.prefect_jobs.models import (  # noqa: E402
    DeepSearchSubmitRequest,
    JobStatus,
    build_flow_run_tags,
    normalize_flow_run,
    prefect_state_names_for_job_status,
    prefect_state_to_job_status,
)

TEST_DEEP_SEARCH_INSTRUCTIONS = "Write a focused test report."


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


def _start_fake_besedy_server(
    *,
    search_status: int = 200,
    search_payload: dict | None = None,
) -> tuple[ThreadingHTTPServer, threading.Thread, list[dict[str, object]]]:
    requests: list[dict[str, object]] = []
    default_search_payload = {
        "catalogId": "catalog-1",
        "query": "test query",
        "results": [
            {
                "chunkId": "chunk-1",
                "audioHash": "hash-1",
                "score": 9.5,
                "startSec": 10,
                "endSec": 20,
                "text": "primary evidence",
            },
            {
                "chunkId": "chunk-2",
                "audioHash": "hash-2",
                "score": 8.0,
                "startSec": 30,
                "endSec": 40,
                "text": "secondary evidence",
            },
        ],
        "retrieval": {"fusedCandidates": 2},
        "timings": {"totalMs": 1.23},
    }

    class FakeBesedyHandler(BaseHTTPRequestHandler):
        server_version = "FakeBesedy/1.0"

        def do_POST(self) -> None:  # noqa: N802
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length).decode("utf-8")
            payload = json.loads(raw_body) if raw_body else {}
            requests.append(
                {
                    "path": self.path,
                    "payload": payload,
                    "authorization": self.headers.get("Authorization"),
                }
            )

            if self.path == "/api/internal/deep-search/search":
                response = default_search_payload if search_payload is None else search_payload
                self._write_json(search_status, response)
                return

            if self.path == "/api/internal/deep-search/citation":
                chunk_id = str(payload.get("chunkId", "missing"))
                self._write_json(
                    200,
                    {
                        "catalogId": str(payload.get("catalogId", "")),
                        "chunk": {
                            "chunkId": chunk_id,
                            "audioHash": f"{chunk_id}-hash",
                            "startSec": 10,
                            "endSec": 20,
                            "text": f"context for {chunk_id}",
                        },
                        "contextText": f"expanded context for {chunk_id}",
                        "metadata": {
                            "date": {"year": 1981, "month": 6, "day": 14},
                            "location": {"id": 1, "name": "Brno"},
                            "recorder": {"id": 2, "name": "Archivist"},
                        },
                    },
                )
                return

            if self.path == "/api/internal/deep-search/metadata":
                self._write_json(
                    200,
                    {
                        "catalogId": str(payload.get("catalogId", "")),
                        "audioHash": str(payload.get("audioHash", "")),
                        "metadata": None,
                    },
                )
                return

            self._write_json(404, {"error": f"Unknown route: {self.path}"})

        def log_message(self, format: str, *args: object) -> None:  # noqa: A003
            return

        def _write_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBesedyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, requests


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
            work_pool_name="besedy-deep-search",
            parameters={
                "catalog_id": "catalog-1",
                "query": "who mentions Brno?",
                "instructions": TEST_DEEP_SEARCH_INSTRUCTIONS,
                "requested_by_id": "admin-1",
                "retrieval": {
                    "top_k": 200,
                    "include_neighbors": True,
                    "neighbor_count": 1,
                    "window": {
                        "neighbor_count": 1,
                    },
                    "lm_profile": None,
                    "sub_lm_profile": None,
                },
                "execution": {},
            },
            state=SimpleNamespace(message=None),
            tags=["job-kind:deep-search", "catalog:catalog-1", "requested-by:admin-1"],
        )
        self.submit_calls: list[dict[str, object]] = []
        self.cancelled = False

    def create_deep_search_run(
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


@pytest.mark.parametrize("configured_mode", [None, ""])
def test_deep_search_execution_mode_defaults_to_rlm(
    monkeypatch,
    configured_mode: str | None,
) -> None:
    if configured_mode is None:
        monkeypatch.delenv("DEEP_SEARCH_EXECUTION_MODE", raising=False)
    else:
        monkeypatch.setenv("DEEP_SEARCH_EXECUTION_MODE", configured_mode)

    assert (
        rlm_adapter_module.resolve_deep_search_execution_mode(
            execution={},
            has_stub_retrieval=False,
        )
        == rlm_adapter_module.DeepSearchExecutionMode.RLM
    )


def test_prefect_jobs_service_http_round_trip(monkeypatch) -> None:
    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
    fake_client = FakePrefectClient()
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(
            client=fake_client,
            output_root_dir=Path(tmp_dir),
            deployment_name="deep_search_flow/deep-search-default",
            prefect_ui_url="http://prefect.example",
        )
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            created = _request_json(
                "POST",
                f"{base_url}/catalogs/catalog-1/deep-search/jobs",
                {
                    "query": "who mentions Brno?",
                    "requestedById": "admin-1",
                },
                bearer_token="jobs-secret",
            )
            assert created["id"] == fake_client.flow_run_id
            assert created["status"] == JobStatus.QUEUED.value
            assert (
                fake_client.submit_calls[0]["deployment_name"]
                == "deep_search_flow/deep-search-default"
            )

            listed = _request_json(
                "GET",
                f"{base_url}/jobs?kind=DEEP_SEARCH&catalogId=catalog-1",
                bearer_token="jobs-secret",
            )
            assert [job["id"] for job in listed["jobs"]] == [fake_client.flow_run_id]

            detail = _request_json(
                "GET",
                f"{base_url}/jobs/{fake_client.flow_run_id}",
                bearer_token="jobs-secret",
            )
            assert detail["payload"]["query"] == "who mentions Brno?"

            history = _request_json(
                "GET",
                f"{base_url}/jobs/{fake_client.flow_run_id}/history",
                bearer_token="jobs-secret",
            )
            assert [event["stateName"] for event in history["events"]] == ["Scheduled", "Running"]
            assert history["prefectUiUrl"].endswith(fake_client.flow_run_id)

            cancelled = _request_json(
                "POST",
                f"{base_url}/jobs/{fake_client.flow_run_id}/cancel",
                bearer_token="jobs-secret",
            )
            assert cancelled["status"] == JobStatus.RUNNING.value
            assert fake_client.cancelled is True
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_prefect_jobs_service_health_does_not_require_bearer_token(monkeypatch) -> None:
    monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET", raising=False)
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=FakePrefectClient(), output_root_dir=Path(tmp_dir))
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            health = _request_json("GET", f"{base_url}/health")
            assert health["ready"] is True
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


@pytest.mark.parametrize(
    ("configured_secret", "authorization"),
    [
        ("jobs-secret", None),
        ("jobs-secret", "Bearer wrong-secret"),
        (None, "Bearer jobs-secret"),
    ],
)
def test_prefect_jobs_service_requires_bearer_token(
    monkeypatch,
    configured_secret: str | None,
    authorization: str | None,
) -> None:
    if configured_secret is None:
        monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET", raising=False)
    else:
        monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", configured_secret)

    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=FakePrefectClient(), output_root_dir=Path(tmp_dir))
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            headers = {"Authorization": authorization} if authorization is not None else {}
            request = Request(f"{base_url}/jobs", method="GET", headers=headers)
            try:
                urlopen(request, timeout=5)
            except HTTPError as exc:
                assert exc.code == 401
                payload = json.loads(exc.read().decode("utf-8"))
                assert payload["error"] == "unauthorized"
            else:  # pragma: no cover - defensive
                raise AssertionError("Expected HTTPError for unauthorized jobs-api request.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_deep_search_submit_request_rejects_legacy_bundle_key() -> None:
    with pytest.raises(
        ValueError,
        match="bundleKey has been removed. Use lmProfile and subLmProfile instead.",
    ):
        DeepSearchSubmitRequest.from_payload(
            {
                "query": "who mentions Brno?",
                "instructions": TEST_DEEP_SEARCH_INSTRUCTIONS,
                "bundleKey": "bundle-1",
            }
        )


def test_deep_search_submit_request_defaults_instructions(monkeypatch) -> None:
    monkeypatch.setattr(
        models_module,
        "get_deep_search_default_instructions",
        lambda: TEST_DEEP_SEARCH_INSTRUCTIONS,
    )

    request = DeepSearchSubmitRequest.from_payload({"query": "who mentions Brno?"})

    assert request.query == "who mentions Brno?"
    assert request.instructions == TEST_DEEP_SEARCH_INSTRUCTIONS


def test_deep_search_submit_request_rejects_empty_instructions() -> None:
    with pytest.raises(ValueError, match="instructions must not be empty"):
        DeepSearchSubmitRequest.from_payload(
            {
                "query": "who mentions Brno?",
                "instructions": " ",
            }
        )


def test_deep_search_submit_request_rejects_removed_form_field() -> None:
    with pytest.raises(ValueError, match="form has been removed"):
        DeepSearchSubmitRequest.from_payload(
            {
                "query": "who mentions Brno?",
                "form": "Write a report.",
            }
        )


def test_prefect_jobs_service_submit_preserves_optional_instructions() -> None:
    fake_client = FakePrefectClient()
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=fake_client, output_root_dir=Path(tmp_dir))
        created = service.submit_deep_search(
            catalog_id="catalog-1",
            payload={
                "query": "who mentions Brno?",
                "instructions": f" {TEST_DEEP_SEARCH_INSTRUCTIONS} ",
            },
        )

    assert created["payload"]["instructions"] == TEST_DEEP_SEARCH_INSTRUCTIONS
    assert (
        fake_client.submit_calls[0]["parameters"]["instructions"] == TEST_DEEP_SEARCH_INSTRUCTIONS
    )


def test_prefect_jobs_service_submit_maps_lm_profiles(monkeypatch) -> None:
    monkeypatch.setattr(
        models_module,
        "get_deep_search_default_instructions",
        lambda: TEST_DEEP_SEARCH_INSTRUCTIONS,
    )

    fake_client = FakePrefectClient()
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=fake_client, output_root_dir=Path(tmp_dir))
        created = service.submit_deep_search(
            catalog_id="catalog-1",
            payload={
                "query": "who mentions Brno?",
                "lmProfile": "custom-main",
                "subLmProfile": "custom-sub",
            },
        )

    assert created["payload"]["retrieval"] == {
        "top_k": 200,
        "include_neighbors": True,
        "neighbor_count": 1,
        "window": {
            "neighbor_count": 1,
        },
        "lm_profile": "custom-main",
        "sub_lm_profile": "custom-sub",
    }
    assert created["payload"]["instructions"] == TEST_DEEP_SEARCH_INSTRUCTIONS
    assert fake_client.submit_calls[0]["parameters"]["retrieval"] == {
        "top_k": 200,
        "include_neighbors": True,
        "neighbor_count": 1,
        "window": {
            "neighbor_count": 1,
        },
        "lm_profile": "custom-main",
        "sub_lm_profile": "custom-sub",
    }
    assert (
        fake_client.submit_calls[0]["parameters"]["instructions"] == TEST_DEEP_SEARCH_INSTRUCTIONS
    )


def test_prefect_jobs_service_returns_400_for_malformed_json(monkeypatch) -> None:
    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=FakePrefectClient(), output_root_dir=Path(tmp_dir))
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            request = Request(
                f"{base_url}/catalogs/catalog-1/deep-search/jobs",
                data=b"{not-json",
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer jobs-secret",
                },
            )
            try:
                urlopen(request, timeout=5)
            except HTTPError as exc:
                assert exc.code == 400
                payload = json.loads(exc.read().decode("utf-8"))
                assert "Expecting property name" in payload["error"]
            else:  # pragma: no cover - defensive
                raise AssertionError("Expected HTTPError for malformed JSON.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_prefect_jobs_service_returns_400_for_legacy_bundle_key(monkeypatch) -> None:
    monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=FakePrefectClient(), output_root_dir=Path(tmp_dir))
        server = ThreadingHTTPServer(("127.0.0.1", 0), create_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        base_url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            request = Request(
                f"{base_url}/catalogs/catalog-1/deep-search/jobs",
                data=json.dumps(
                    {
                        "query": "who mentions Brno?",
                        "instructions": TEST_DEEP_SEARCH_INSTRUCTIONS,
                        "bundleKey": "bundle-1",
                    }
                ).encode("utf-8"),
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer jobs-secret",
                },
            )
            try:
                urlopen(request, timeout=5)
            except HTTPError as exc:
                assert exc.code == 400
                payload = json.loads(exc.read().decode("utf-8"))
                assert payload["error"] == (
                    "bundleKey has been removed. Use lmProfile and subLmProfile instead."
                )
            else:  # pragma: no cover - defensive
                raise AssertionError("Expected HTTPError for legacy bundleKey payload.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


def test_normalize_flow_run_reads_output_bundle() -> None:
    fake_client = FakePrefectClient()
    with tempfile.TemporaryDirectory() as tmp_dir:
        bundle_dir = Path(tmp_dir) / fake_client.flow_run_id
        bundle_dir.mkdir(parents=True)
        (bundle_dir / "result.json").write_text(
            json.dumps({"markdown": "# Report\n\nBody"}, ensure_ascii=False),
            encoding="utf-8",
        )

        normalized = normalize_flow_run(fake_client.flow_run, output_root_dir=Path(tmp_dir))
        assert normalized["result"]["markdown"].startswith("# Report")
        assert normalized["result_preview"] == "# Report"
        assert normalized["outputBundle"]["bundleDir"] == str(bundle_dir)


def test_normalize_flow_run_preserves_missing_instructions_as_none() -> None:
    fake_client = FakePrefectClient()
    fake_client.flow_run.parameters = {
        "catalog_id": "catalog-1",
        "query": "who mentions Brno?",
        "retrieval": {},
        "execution": {},
    }

    with tempfile.TemporaryDirectory() as tmp_dir:
        normalized = normalize_flow_run(fake_client.flow_run, output_root_dir=Path(tmp_dir))

    assert normalized["payload"]["instructions"] is None


def test_deep_search_flow_validate_inputs_requires_instructions() -> None:
    with pytest.raises(ValueError, match="instructions must not be empty"):
        deep_search_flow_module.validate_inputs.fn(
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=None,
            retrieval={},
            execution={},
        )


def test_normalize_flow_run_ignores_rlm_progress_when_rlmbenchy_log_load_fails(
    monkeypatch,
) -> None:
    fake_client = FakePrefectClient()
    monkeypatch.setattr(
        rlm_logs_module,
        "load_latest_run",
        lambda _log_dir: (_ for _ in ()).throw(ImportError("missing log")),
    )

    with tempfile.TemporaryDirectory() as tmp_dir:
        log_dir = Path(tmp_dir) / fake_client.flow_run_id / "rlmbenchy"
        log_dir.mkdir(parents=True)

        normalized = normalize_flow_run(fake_client.flow_run, output_root_dir=Path(tmp_dir))

    assert normalized["rlmProgress"] is None


def test_normalize_flow_run_ignores_rlm_progress_when_rlmbenchy_api_cannot_project(
    monkeypatch,
) -> None:
    fake_client = FakePrefectClient()

    monkeypatch.setattr(rlm_logs_module, "load_latest_run", lambda _log_dir: {"run_id": "bad-run"})
    monkeypatch.setattr(rlm_logs_module, "run_calls", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(
        rlm_logs_module,
        "summarize_run_progress",
        lambda _run: (_ for _ in ()).throw(ValueError("unsupported log")),
    )

    with tempfile.TemporaryDirectory() as tmp_dir:
        log_dir = Path(tmp_dir) / fake_client.flow_run_id / "rlmbenchy"
        log_dir.mkdir(parents=True)

        normalized = normalize_flow_run(fake_client.flow_run, output_root_dir=Path(tmp_dir))

    assert normalized["rlmProgress"] is None


def test_normalize_flow_run_reads_rlm_progress_from_rlmbenchy_api(monkeypatch) -> None:
    fake_client = FakePrefectClient()
    calls: dict[str, object] = {}
    run_projection = {"run_id": "run-1"}

    def fake_load_latest_run(log_dir: Path) -> dict[str, object]:
        calls["log_dir"] = log_dir
        return run_projection

    def fake_summarize_run_progress(run: dict[str, object]) -> dict[str, int]:
        assert run is run_projection
        return {"steps": 2, "toolCalls": 2, "subLlmCalls": 1}

    def fake_run_calls(run: dict[str, object], *, kind: str | None = None) -> list[dict]:
        assert run is run_projection
        assert kind == "tool"
        return [
            {
                "kind": "tool",
                "name": "search_catalog",
                "response": {
                    "result": {
                        "results": [
                            {
                                "chunkId": "chunk-1",
                                "audioHash": "hash-1",
                                "text": "abc",
                                "contextText": "abcdef",
                            },
                            {
                                "chunkId": "chunk-2",
                                "audioHash": "hash-2",
                                "text": "de",
                            },
                        ]
                    }
                },
            },
            {
                "kind": "tool",
                "name": "get_chunk_window",
                "response": {
                    "result": {
                        "chunk": {
                            "chunkId": "chunk-2",
                            "audioHash": "hash-2",
                            "text": "fghi",
                        },
                        "neighbors": {
                            "before": [{"chunkId": "chunk-1", "audioHash": "hash-1"}],
                            "after": [{"chunkId": "chunk-3", "audioHash": "hash-3"}],
                        },
                        "contextText": "window",
                    }
                },
            },
        ]

    monkeypatch.setattr(rlm_logs_module, "load_latest_run", fake_load_latest_run)
    monkeypatch.setattr(rlm_logs_module, "run_calls", fake_run_calls)
    monkeypatch.setattr(rlm_logs_module, "summarize_run_progress", fake_summarize_run_progress)

    with tempfile.TemporaryDirectory() as tmp_dir:
        log_dir = Path(tmp_dir) / fake_client.flow_run_id / "rlmbenchy"
        log_dir.mkdir(parents=True)

        normalized = normalize_flow_run(fake_client.flow_run, output_root_dir=Path(tmp_dir))

    assert calls["log_dir"] == log_dir
    assert normalized["rlmProgress"] == {
        "steps": 2,
        "toolCalls": 2,
        "subLlmCalls": 1,
        "searchCalls": 1,
        "windowCalls": 1,
        "uniqueChunks": 3,
        "uniqueAudioHashes": 3,
        "retrievedTextChars": 9,
        "retrievedContextChars": 12,
    }


def test_build_flow_run_tags_sanitizes_dynamic_values() -> None:
    tags = build_flow_run_tags(
        catalog_id="Catalog 1",
        requested_by_id="Admin 1",
        caller_scope="Admin/1",
    )
    assert tags == [
        "job-kind:deep-search",
        "catalog:catalog-1",
        "requested-by:admin-1",
        "caller-scope:admin-1",
    ]


def test_prefect_jobs_service_list_jobs_reuses_tag_normalization() -> None:
    fake_client = FakePrefectClient()
    fake_client.flow_run.tags = [
        "job-kind:deep-search",
        "catalog:catalog-1",
        "requested-by:admin-1",
    ]
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=fake_client, output_root_dir=Path(tmp_dir))
        jobs = service.list_jobs(raw_query="catalogId=Catalog%201&requestedById=Admin%201")
        assert [job["id"] for job in jobs["jobs"]] == [fake_client.flow_run_id]
        assert fake_client.read_flow_runs_calls[-1]["tags"] == [
            "job-kind:deep-search",
            "catalog:catalog-1",
            "requested-by:admin-1",
        ]


def test_prefect_jobs_service_list_jobs_passes_status_filter_to_client() -> None:
    fake_client = FakePrefectClient()
    fake_client.flow_run.state_name = "Failed"
    fake_client.flow_run.state_type = "FAILED"
    with tempfile.TemporaryDirectory() as tmp_dir:
        service = PrefectJobsApiService(client=fake_client, output_root_dir=Path(tmp_dir))
        jobs = service.list_jobs(raw_query="status=FAILED&limit=50")
        assert [job["id"] for job in jobs["jobs"]] == [fake_client.flow_run_id]
        assert fake_client.read_flow_runs_calls[-1]["state_names"] == [
            "Failed",
            "Crashed",
            "TimedOut",
        ]


def test_deploy_cli_registers_runner_deployment(monkeypatch) -> None:
    ensure_calls: list[dict[str, object]] = []
    deployment_calls: list[dict[str, object]] = []
    apply_calls: list[dict[str, object]] = []

    class FakeClient:
        def ensure_process_work_pool(
            self,
            *,
            name: str,
            concurrency_limit: int | None,
        ) -> None:
            ensure_calls.append({"name": name, "concurrency_limit": concurrency_limit})

    class FakeRunnerDeployment:
        def apply(
            self,
            *,
            work_pool_name: str | None = None,
            image: str | None = None,
            version_info: object | None = None,
        ) -> str:
            apply_calls.append(
                {
                    "work_pool_name": work_pool_name,
                    "image": image,
                    "version_info": version_info,
                }
            )
            return "deployment-id"

    class FakeFlow:
        def to_deployment(self, **kwargs: object) -> FakeRunnerDeployment:
            deployment_calls.append(kwargs)
            return FakeRunnerDeployment()

    monkeypatch.setattr(deploy_module, "RuntimePrefectJobsClient", lambda: FakeClient())
    monkeypatch.setattr(deploy_module, "deep_search_flow", FakeFlow())

    assert (
        deploy_module.main(
            [
                "--work-pool",
                "besedy-deep-search",
                "--deployment-name",
                "deep-search-default",
                "--concurrency-limit",
                "2",
            ]
        )
        == 0
    )

    assert ensure_calls == [{"name": "besedy-deep-search", "concurrency_limit": 2}]
    assert deployment_calls == [
        {
            "name": "deep-search-default",
            "work_pool_name": "besedy-deep-search",
            "parameters": {},
            "tags": ["job-kind:deep-search"],
            "concurrency_limit": 2,
            "entrypoint_type": deploy_module.EntrypointType.MODULE_PATH,
        }
    ]
    assert apply_calls == [
        {
            "work_pool_name": "besedy-deep-search",
            "image": None,
            "version_info": None,
        }
    ]


def test_persist_output_bundle_task_writes_expected_files(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        monkeypatch.setenv("DEEP_SEARCH_OUTPUT_DIR", tmp_dir)
        bundle = deep_search_flow_module.persist_output_bundle.fn(
            flow_run_id="flow-run-1",
            inputs={"catalog_id": "catalog-1", "query": "Brno?"},
            initial_hits=[{"chunkId": "chunk-1"}],
            result={
                "markdown": "# Report\n\nBody",
                "trace": {"initialRetrieval": {"hits": [{"chunkId": "chunk-1"}]}},
            },
        )

        bundle_dir = Path(bundle["outputDir"])
        assert bundle["flowRunId"] == "flow-run-1"
        assert (bundle_dir / "report.md").read_text(encoding="utf-8").startswith("# Report")
        assert (bundle_dir / "result.json").is_file()
        assert (bundle_dir / "initial_hits.json").is_file()
        assert (bundle_dir / "followup_trace.json").is_file()
        assert (bundle_dir / "run_metadata.json").is_file()


def test_deep_search_tasks_use_besedy_internal_retrieval_when_configured(
    monkeypatch,
) -> None:
    server, thread, requests = _start_fake_besedy_server()
    try:
        monkeypatch.setenv("DEEP_SEARCH_EXECUTION_MODE", "retrieval")
        monkeypatch.setenv(
            "BESEDY_INTERNAL_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}"
        )
        monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
        monkeypatch.setenv("BESEDY_INTERNAL_TIMEOUT_MS", "2000")

        inputs = deep_search_flow_module.validate_inputs.fn(
            catalog_id="catalog-1",
            query="test query",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={"top_k": 2},
            execution={"citation_limit": 2, "citation_neighbor_count": 1},
        )
        initial = deep_search_flow_module.run_initial_retrieval.fn(inputs)
        expansions = deep_search_flow_module.expand_citations.fn(inputs, initial)
        result = deep_search_flow_module.run_rlm_deep_search.fn(
            flow_run_id="flow-run-1",
            inputs=inputs,
            initial_retrieval=initial,
            citation_expansions=expansions,
        )

        assert initial["stub"] is False
        assert len(initial["hits"]) == 2
        assert len(expansions) == 2
        assert result["trace"]["stub"] is False
        assert result["trace"]["executionMode"] == "retrieval"
        assert result["report"]["jobId"] == "flow-run-1"
        assert "expanded context for chunk-1" in result["markdown"]
        assert [request["path"] for request in requests] == [
            "/api/internal/deep-search/search",
            "/api/internal/deep-search/citation",
            "/api/internal/deep-search/citation",
        ]
        assert all(request["authorization"] == "Bearer jobs-secret" for request in requests)
        assert requests[0]["payload"] == {
            "catalogId": "catalog-1",
            "query": "test query",
            "limit": 2,
            "includeNeighbors": True,
            "neighborCount": 1,
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_deep_search_tasks_fall_back_to_stub_without_besedy_client(monkeypatch) -> None:
    monkeypatch.delenv("BESEDY_INTERNAL_BASE_URL", raising=False)
    monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET", raising=False)

    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="stub query",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={},
    )
    initial = deep_search_flow_module.run_initial_retrieval.fn(inputs)
    expansions = deep_search_flow_module.expand_citations.fn(inputs, initial)
    result = deep_search_flow_module.run_rlm_deep_search.fn(
        flow_run_id="flow-run-1",
        inputs=inputs,
        initial_retrieval=initial,
        citation_expansions=expansions,
    )

    assert initial["stub"] is True
    assert expansions == []
    assert result["trace"]["stub"] is True
    assert result["trace"]["executionMode"] == "stub"
    assert "Stub flow completed successfully." in result["markdown"]


def test_run_rlm_deep_search_uses_rlm_adapter_when_enabled(monkeypatch) -> None:
    monkeypatch.setenv("DEEP_SEARCH_EXECUTION_MODE", "rlm")
    captured: dict[str, object] = {}

    def fake_run_rlmbenchy_deep_search(**kwargs):
        captured.update(kwargs)
        return {
            "query": kwargs["query"],
            "markdown": "# Deep Search (RLM)\n\nBody\n",
            "report": {"title": "Deep Search (RLM)"},
            "trace": {"executionMode": "rlm", "executor": "rlmbenchy_rlm"},
        }

    monkeypatch.setattr(
        deep_search_flow_module,
        "build_besedy_deep_search_client_from_env",
        lambda: object(),
    )
    monkeypatch.setattr(
        deep_search_flow_module,
        "run_rlmbenchy_deep_search",
        fake_run_rlmbenchy_deep_search,
    )

    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="who mentions Brno?",
        instructions="Write a concise report.",
        retrieval={
            "top_k": 2,
            "lm_profile": "custom-main",
            "sub_lm_profile": "custom-sub",
        },
        execution={"mode": "rlm"},
    )
    initial_retrieval = {
        "query": "who mentions Brno?",
        "retrieval": {},
        "timings": {},
        "hits": [{"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"}],
        "stub": False,
    }
    citation_expansions = [{"chunk": {"chunkId": "chunk-1"}, "contextText": "expanded"}]

    result = deep_search_flow_module.run_rlm_deep_search.fn(
        flow_run_id="flow-run-rlm",
        inputs=inputs,
        initial_retrieval=initial_retrieval,
        citation_expansions=citation_expansions,
    )

    assert result["trace"]["executionMode"] == "rlm"
    assert captured["flow_run_id"] == "flow-run-rlm"
    assert captured["catalog_id"] == "catalog-1"
    assert captured["query"] == "who mentions Brno?"
    assert captured["instructions"] == "Write a concise report."
    assert captured["retrieval"] == {
        "top_k": 2,
        "lm_profile": "custom-main",
        "sub_lm_profile": "custom-sub",
    }
    assert captured["execution"] == {"mode": "rlm"}
    assert captured["initial_retrieval"] == initial_retrieval
    assert captured["citation_expansions"] == citation_expansions


def test_run_rlm_deep_search_wraps_rlm_failure_with_partial_trace(monkeypatch) -> None:
    monkeypatch.setenv("DEEP_SEARCH_EXECUTION_MODE", "rlm")
    monkeypatch.setattr(
        deep_search_flow_module,
        "build_besedy_deep_search_client_from_env",
        lambda: object(),
    )
    monkeypatch.setattr(
        deep_search_flow_module,
        "run_rlmbenchy_deep_search",
        lambda **kwargs: (_ for _ in ()).throw(
            deep_search_flow_module.RlmAdapterError(
                "rlmbenchy execution failed: boom",
                status_code=504,
                retryable=True,
                partial_trace={
                    "executionMode": "rlm",
                    "executor": "rlmbenchy_rlm",
                    "followUpSearches": [{"query": "more evidence"}],
                    "rlm": {"iterations": 2},
                },
            )
        ),
    )

    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="who mentions Brno?",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={"mode": "rlm"},
    )
    initial_retrieval = {
        "query": "who mentions Brno?",
        "retrieval": {},
        "timings": {},
        "hits": [{"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"}],
        "stub": False,
    }
    citation_expansions = [{"chunk": {"chunkId": "chunk-1"}, "contextText": "expanded"}]

    with pytest.raises(deep_search_flow_module.DeepSearchFlowError) as exc_info:
        deep_search_flow_module.run_rlm_deep_search.fn(
            flow_run_id="flow-run-rlm",
            inputs=inputs,
            initial_retrieval=initial_retrieval,
            citation_expansions=citation_expansions,
        )

    partial = exc_info.value.partial_result
    assert exc_info.value.status_code == 504
    assert exc_info.value.retryable is True
    assert partial is not None
    assert partial["failedStage"] == "rlm_execution"
    assert partial["traceExtras"]["executionMode"] == "rlm"
    assert partial["traceExtras"]["executor"] == "rlmbenchy_rlm"
    assert partial["traceExtras"]["followUpSearches"] == [{"query": "more evidence"}]
    assert partial["traceExtras"]["rlm"] == {"iterations": 2}


def _fake_lm_profile(*, api_base: str, model: str) -> SimpleNamespace:
    return SimpleNamespace(
        api_base=api_base,
        model=model,
        api_key=None,
        api_key_env=None,
        request_kwargs={"temperature": 1.0},
        supported_parameter_mode="off",
        ignore_unsupported_parameters=frozenset(),
        lm_transport="auto",
    )


def _build_runtime_mocks(
    *,
    profiles_by_path: dict[Path, SimpleNamespace],
    run_task,
    build_lm_holder: dict[str, object] | None = None,
) -> dict[str, object]:
    class FakeRuntime:
        pass

    def fake_resolve_lm_profile_path(raw: str) -> Path:
        return Path(f"/resolved/{raw}.toml")

    def fake_load_lm_profile(path: Path) -> SimpleNamespace:
        if path not in profiles_by_path:
            raise AssertionError(f"unexpected profile path: {path}")
        return profiles_by_path[path]

    def fake_build_lm(**kwargs):
        if build_lm_holder is not None:
            build_lm_holder.update(kwargs)
        return SimpleNamespace(kind="sub-lm", **kwargs)

    def fake_extract_final_answer(task_run: object) -> str | None:
        for source in (task_run, getattr(task_run, "loop_result", None)):
            outputs = getattr(source, "final_outputs", None)
            if isinstance(outputs, dict):
                answer = outputs.get("answer")
                if isinstance(answer, str) and answer.strip():
                    return answer
        return None

    def fake_loop_result_summary(loop_result: object) -> dict[str, object]:
        if loop_result is None:
            return {}
        return {
            "stopReason": getattr(loop_result, "stop_reason", None),
            "iterations": getattr(loop_result, "iterations", None),
            "error": getattr(loop_result, "error", None),
        }

    class FakeWorkloadDeepSearchClientError(RuntimeError):
        def __init__(
            self,
            message: str,
            *,
            status_code: int,
            payload: dict[str, object] | None = None,
        ) -> None:
            super().__init__(message)
            self.status_code = status_code
            self.payload = payload

    class FakeActiveTask:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *args: object) -> None:
            return None

    def fake_active_task(_task_id: str) -> FakeActiveTask:
        return FakeActiveTask()

    def fake_call_with_retry(operation):
        attempts = 0
        while True:
            attempts += 1
            try:
                return operation()
            except FakeWorkloadDeepSearchClientError as exc:
                if attempts >= 3 or exc.status_code not in {429, 502, 503, 504}:
                    raise

    def fake_build_besedy_deep_search_tools(*, client, task_context_by_id):
        context = next(iter(task_context_by_id.values()))
        retrieval = context["retrieval"]
        window = context["window"]

        def search_catalog(
            query: str,
            top_k: int | None = None,
            include_neighbors: bool | None = None,
            neighbor_count: int | None = None,
        ):
            return fake_call_with_retry(
                lambda: client.search_catalog(
                    catalog_id=context["catalog_id"],
                    query=query,
                    top_k=top_k or retrieval["top_k"],
                    include_neighbors=(
                        retrieval["include_neighbors"]
                        if include_neighbors is None
                        else include_neighbors
                    ),
                    neighbor_count=(
                        retrieval["neighbor_count"] if neighbor_count is None else neighbor_count
                    ),
                )
            )

        def get_chunk_window(chunk_id: str, neighbor_count: int | None = None):
            return fake_call_with_retry(
                lambda: client.get_chunk_window(
                    catalog_id=context["catalog_id"],
                    chunk_id=chunk_id,
                    neighbor_count=neighbor_count or window["neighbor_count"],
                )
            )

        def get_metadata(audio_hash: str):
            return fake_call_with_retry(
                lambda: client.get_metadata(
                    catalog_id=context["catalog_id"],
                    audio_hash=audio_hash,
                )
            )

        return {
            "search_catalog": search_catalog,
            "get_chunk_window": get_chunk_window,
            "get_metadata": get_metadata,
        }

    return {
        "DockerReplRuntime": type("DockerRuntime", (), {}),
        "LocalProcessReplRuntime": FakeRuntime,
        "RLMRunConfig": lambda **kwargs: SimpleNamespace(kind="rlm-run-config", **kwargs),
        "build_lm": fake_build_lm,
        "extract_final_answer": fake_extract_final_answer,
        "is_retryable_tool_error": lambda _loop_result: False,
        "loop_result_summary": fake_loop_result_summary,
        "resolve_model_api_key": lambda **_kwargs: "resolved-key",
        "run_task": run_task,
        "load_lm_profile": fake_load_lm_profile,
        "resolve_lm_profile_path": fake_resolve_lm_profile_path,
        "validate_supported_parameters_for_openrouter": lambda **_kwargs: None,
        "BesedyDeepSearchSignature": "fake-besedy-signature",
        "build_besedy_deep_search_signature": (
            lambda instructions: f"fake-besedy-signature:{instructions}"
        ),
        "WorkloadDeepSearchClientError": FakeWorkloadDeepSearchClientError,
        "active_task": fake_active_task,
        "build_besedy_deep_search_tools": fake_build_besedy_deep_search_tools,
        "DEFAULT_RETRIEVAL_TOP_K": 200,
        "DEFAULT_SEARCH_INCLUDE_NEIGHBORS": True,
        "DEFAULT_SEARCH_NEIGHBOR_COUNT": 1,
        "DEFAULT_WINDOW_NEIGHBOR_COUNT": 1,
        "MAX_SEARCH_NEIGHBOR_COUNT": 3,
        "MAX_WINDOW_NEIGHBOR_COUNT": 5,
    }


def _install_runtime_mocks(
    monkeypatch: pytest.MonkeyPatch,
    runtime_mocks: dict[str, object],
) -> None:
    for name in (
        "extract_final_answer",
        "is_retryable_tool_error",
        "loop_result_summary",
        "run_task",
        "active_task",
        "build_besedy_deep_search_signature",
        "build_besedy_deep_search_tools",
    ):
        monkeypatch.setattr(rlm_adapter_module, name, runtime_mocks[name])

    for name in (
        "DockerReplRuntime",
        "LocalProcessReplRuntime",
        "RLMRunConfig",
        "build_lm",
        "load_lm_profile",
        "resolve_lm_profile_path",
        "resolve_model_api_key",
        "validate_supported_parameters_for_openrouter",
    ):
        monkeypatch.setattr(rlm_runtime_module, name, runtime_mocks[name])


def test_run_rlmbenchy_deep_search_uses_direct_runtime_imports(monkeypatch, tmp_path: Path) -> None:
    build_lm_kwargs: dict[str, object] = {}
    run_task_kwargs: dict[str, object] = {}

    main_path = Path("/resolved/model-openrouter-openai-gpt-oss-120b_high.toml")
    sub_path = Path("/resolved/model-openrouter-openai-gpt-oss-20b_high.toml")
    profiles = {
        main_path: _fake_lm_profile(
            api_base="https://openrouter.ai/api/v1",
            model="openrouter/openai/gpt-oss-120b",
        ),
        sub_path: _fake_lm_profile(
            api_base="https://openrouter.ai/api/v1",
            model="openrouter/openai/gpt-oss-20b",
        ),
    }

    def fake_run_task(**kwargs):
        run_task_kwargs.update(kwargs)
        return (
            SimpleNamespace(
                final_outputs={"answer": "## Query\n\nwho mentions Brno?\n"},
                loop_result=SimpleNamespace(
                    final_outputs={"answer": "## Query\n\nwho mentions Brno?\n"},
                    error=None,
                    stop_reason="success",
                    iterations=2,
                    metadata={"trace": "ok"},
                ),
            ),
            object(),
        )

    runtime_mocks = _build_runtime_mocks(
        profiles_by_path=profiles,
        run_task=fake_run_task,
        build_lm_holder=build_lm_kwargs,
    )
    _install_runtime_mocks(monkeypatch, runtime_mocks)
    monkeypatch.setenv("RLMBENCHY_LM_PROFILE", "model-openrouter-openai-gpt-oss-120b_high")
    monkeypatch.setenv("RLMBENCHY_SUB_LM_PROFILE", "model-openrouter-openai-gpt-oss-20b_high")
    monkeypatch.delenv("RLMBENCHY_ADAPTER_MODE", raising=False)
    monkeypatch.delenv("RLMBENCHY_SEED", raising=False)
    monkeypatch.delenv("RLMBENCHY_REPL_BACKEND", raising=False)

    result = rlm_adapter_module.run_rlmbenchy_deep_search(
        flow_run_id="flow-run-1",
        catalog_id="catalog-1",
        query="who mentions Brno?",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={},
        initial_retrieval={
            "query": "who mentions Brno?",
            "hits": [{"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"}],
        },
        citation_expansions=[{"chunk": {"chunkId": "chunk-1"}, "contextText": "expanded"}],
        client=SimpleNamespace(),
        output_root_dir=tmp_path,
    )

    assert run_task_kwargs["signature"] == f"fake-besedy-signature:{TEST_DEEP_SEARCH_INSTRUCTIONS}"
    assert run_task_kwargs["task_inputs"] == {"query": "who mentions Brno?"}
    assert run_task_kwargs["task_started_data"] == {
        "workload": "besedy_deep_search",
        "query": "who mentions Brno?",
        "instructions": TEST_DEEP_SEARCH_INSTRUCTIONS,
    }
    assert set(run_task_kwargs["tools"]) == {
        "search_catalog",
        "get_chunk_window",
        "get_metadata",
    }
    assert run_task_kwargs["run_metadata"] == {
        "runner": "rlm",
        "run_scope": "task",
        "lm_profile_path": str(main_path),
        "sub_lm_profile_path": str(sub_path),
        "adapter_mode": "auto",
        "repl_backend": "local",
        "seed": 1,
        "workload": "besedy_deep_search",
        "instructions": TEST_DEEP_SEARCH_INSTRUCTIONS,
    }
    assert isinstance(run_task_kwargs["runtime"], runtime_mocks["LocalProcessReplRuntime"])

    run_config = run_task_kwargs["run_config"]
    assert run_config.model == "openrouter/openai/gpt-oss-120b"
    assert run_config.adapter_mode == "auto"
    assert run_config.request_kwargs["seed"] == 1

    assert build_lm_kwargs["model"] == "openrouter/openai/gpt-oss-20b"
    assert run_task_kwargs["sub_lm"].kind == "sub-lm"

    trace = result["trace"]
    assert trace["executionMode"] == "rlm"
    assert trace["executor"] == "rlmbenchy_rlm"
    assert trace["workload"] == "besedy_deep_search"
    assert "instructions" not in trace
    assert trace["effectiveRetrieval"] == {
        "topK": 200,
        "includeNeighbors": True,
        "neighborCount": 1,
        "windowNeighborCount": 1,
    }
    assert trace["effectiveExecution"] == {
        "mode": "rlm",
        "executor": "rlmbenchy_rlm",
        "workload": "besedy_deep_search",
        "adapterMode": "auto",
        "replBackend": "local",
        "seed": 1,
        "logDir": str(tmp_path / "flow-run-1" / "rlmbenchy"),
        "lmProfile": "model-openrouter-openai-gpt-oss-120b_high",
        "lmProfilePath": str(main_path),
        "lmModelId": "openrouter/openai/gpt-oss-120b",
        "subLmProfile": "model-openrouter-openai-gpt-oss-20b_high",
        "subLmProfilePath": str(sub_path),
        "subLmModelId": "openrouter/openai/gpt-oss-20b",
    }
    assert trace["rlm"]["main"]["modelId"] == "openrouter/openai/gpt-oss-120b"
    assert trace["rlm"]["main"]["profilePath"] == str(main_path)
    assert trace["rlm"]["sub"]["modelId"] == "openrouter/openai/gpt-oss-20b"
    assert trace["rlm"]["sub"]["profilePath"] == str(sub_path)
    assert trace["rlm"]["adapterMode"] == "auto"
    assert trace["rlm"]["replBackend"] == "local"
    assert trace["rlm"]["stopReason"] == "success"
    assert trace["rlm"]["iterations"] == 2
    assert "metadata" not in trace["rlm"]


def test_run_rlmbenchy_deep_search_requires_instructions(monkeypatch, tmp_path: Path) -> None:
    with pytest.raises(rlm_adapter_module.RlmAdapterError, match="instructions must not be empty"):
        rlm_adapter_module.run_rlmbenchy_deep_search(
            flow_run_id="flow-run-missing-instructions",
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=None,
            retrieval={},
            execution={},
            initial_retrieval={"hits": []},
            citation_expansions=[],
            client=SimpleNamespace(),
            output_root_dir=tmp_path,
        )


def test_resolve_lm_profiles_requires_configured_refs(monkeypatch) -> None:
    monkeypatch.delenv("RLMBENCHY_LM_PROFILE", raising=False)
    monkeypatch.delenv("RLMBENCHY_SUB_LM_PROFILE", raising=False)

    with pytest.raises(ValueError, match="Missing main LM profile"):
        rlm_adapter_module.resolve_lm_profiles(retrieval={})


def test_run_rlmbenchy_deep_search_honours_retrieval_profile_overrides(
    monkeypatch,
    tmp_path: Path,
) -> None:
    run_task_kwargs: dict[str, object] = {}

    override_main = Path("/resolved/custom-main.toml")
    override_sub = Path("/resolved/custom-sub.toml")
    profiles = {
        override_main: _fake_lm_profile(
            api_base="https://example.test/v1",
            model="example/main",
        ),
        override_sub: _fake_lm_profile(
            api_base="https://example.test/v1",
            model="example/sub",
        ),
    }

    def fake_run_task(**kwargs):
        run_task_kwargs.update(kwargs)
        return (
            SimpleNamespace(
                final_outputs={"answer": "ok"},
                loop_result=SimpleNamespace(
                    final_outputs={"answer": "ok"},
                    error=None,
                    stop_reason="success",
                    iterations=1,
                    metadata=None,
                ),
            ),
            object(),
        )

    runtime_mocks = _build_runtime_mocks(
        profiles_by_path=profiles,
        run_task=fake_run_task,
    )
    _install_runtime_mocks(monkeypatch, runtime_mocks)

    rlm_adapter_module.run_rlmbenchy_deep_search(
        flow_run_id="flow-run-2",
        catalog_id="catalog-1",
        query="who mentions Brno?",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={
            "lm_profile": "custom-main",
            "sub_lm_profile": "custom-sub",
            "adapter_mode": "chat",
        },
        execution={},
        initial_retrieval={"hits": []},
        citation_expansions=[],
        client=SimpleNamespace(),
        output_root_dir=tmp_path,
    )

    assert run_task_kwargs["run_metadata"]["lm_profile_path"] == str(override_main)
    assert run_task_kwargs["run_metadata"]["sub_lm_profile_path"] == str(override_sub)
    assert run_task_kwargs["run_metadata"]["adapter_mode"] == "chat"
    assert run_task_kwargs["run_config"].model == "example/main"


def test_run_rlmbenchy_deep_search_uses_rlmbenchy_retry_classifier(
    monkeypatch,
    tmp_path: Path,
) -> None:
    main_path = Path("/resolved/model-openrouter-openai-gpt-oss-120b_high.toml")
    sub_path = Path("/resolved/model-openrouter-openai-gpt-oss-20b_high.toml")
    profiles = {
        main_path: _fake_lm_profile(
            api_base="https://openrouter.ai/api/v1",
            model="openrouter/openai/gpt-oss-120b",
        ),
        sub_path: _fake_lm_profile(
            api_base="https://openrouter.ai/api/v1",
            model="openrouter/openai/gpt-oss-20b",
        ),
    }

    def fake_run_task(**_kwargs):
        return (
            SimpleNamespace(
                final_outputs=None,
                loop_result=SimpleNamespace(
                    final_outputs=None,
                    error="tool failed",
                    stop_reason="error",
                    iterations=2,
                    metadata=object(),
                ),
            ),
            object(),
        )

    runtime_mocks = _build_runtime_mocks(
        profiles_by_path=profiles,
        run_task=fake_run_task,
    )
    seen_loop_results: list[object] = []

    def fake_is_retryable_tool_error(loop_result: object) -> bool:
        seen_loop_results.append(loop_result)
        return True

    runtime_mocks["is_retryable_tool_error"] = fake_is_retryable_tool_error
    _install_runtime_mocks(monkeypatch, runtime_mocks)
    monkeypatch.setenv("RLMBENCHY_LM_PROFILE", "model-openrouter-openai-gpt-oss-120b_high")
    monkeypatch.setenv("RLMBENCHY_SUB_LM_PROFILE", "model-openrouter-openai-gpt-oss-20b_high")

    with pytest.raises(rlm_adapter_module.RlmAdapterError) as exc_info:
        rlm_adapter_module.run_rlmbenchy_deep_search(
            flow_run_id="flow-run-1",
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={},
            execution={},
            initial_retrieval={
                "query": "who mentions Brno?",
                "hits": [{"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"}],
            },
            citation_expansions=[{"chunk": {"chunkId": "chunk-1"}, "contextText": "expanded"}],
            client=SimpleNamespace(),
            output_root_dir=tmp_path,
        )

    assert str(exc_info.value) == "rlmbenchy finished without a final answer."
    assert exc_info.value.retryable is True
    assert len(seen_loop_results) == 1


def test_run_rlmbenchy_deep_search_wraps_runtime_initialization_failures(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        rlm_adapter_module,
        "resolve_lm_profiles",
        lambda **_kwargs: (_ for _ in ()).throw(ImportError("bad runtime initialization")),
    )

    with pytest.raises(rlm_adapter_module.RlmAdapterError) as exc_info:
        rlm_adapter_module.run_rlmbenchy_deep_search(
            flow_run_id="flow-run-import-failure",
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={},
            execution={},
            initial_retrieval={"hits": []},
            citation_expansions=[],
            client=SimpleNamespace(),
            output_root_dir=tmp_path,
        )

    assert str(exc_info.value) == ("Failed to initialize rlmbenchy: bad runtime initialization")


def test_run_rlmbenchy_deep_search_rejects_legacy_bundle_flow_inputs(
    monkeypatch,
    tmp_path: Path,
) -> None:
    with pytest.raises(rlm_adapter_module.RlmAdapterError) as exc_info:
        rlm_adapter_module.run_rlmbenchy_deep_search(
            flow_run_id="flow-run-legacy-bundle",
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={"bundle_key": "bundle-1"},
            execution={},
            initial_retrieval={"hits": []},
            citation_expansions=[],
            client=SimpleNamespace(),
            output_root_dir=tmp_path,
        )

    assert str(exc_info.value) == (
        "Legacy bundle-based LM selection has been removed. "
        "Use retrieval.lm_profile and retrieval.sub_lm_profile instead."
    )


def test_run_rlmbenchy_deep_search_rejects_legacy_bundle_env(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("RLMBENCHY_BUNDLE_KEY", "bundle-1")

    with pytest.raises(rlm_adapter_module.RlmAdapterError) as exc_info:
        rlm_adapter_module.run_rlmbenchy_deep_search(
            flow_run_id="flow-run-legacy-env",
            catalog_id="catalog-1",
            query="who mentions Brno?",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={},
            execution={},
            initial_retrieval={"hits": []},
            citation_expansions=[],
            client=SimpleNamespace(),
            output_root_dir=tmp_path,
        )

    assert str(exc_info.value) == (
        "RLMBENCHY_BUNDLE_KEY is no longer supported. "
        "Use RLMBENCHY_LM_PROFILE and RLMBENCHY_SUB_LM_PROFILE instead."
    )


def test_rlm_tool_wrappers_retry_transient_besedy_failures(monkeypatch) -> None:
    class FlakyClient:
        def __init__(self) -> None:
            self.calls = 0

        def search_catalog(
            self,
            *,
            catalog_id: str,
            query: str,
            top_k: int,
            include_neighbors: bool,
            neighbor_count: int,
        ) -> dict[str, object]:
            self.calls += 1
            if self.calls < 2:
                raise rlm_adapter_module.DeepSearchClientError(
                    "Internal deep-search request timed out.",
                    status_code=504,
                )
            return {
                "query": query,
                "results": [{"chunkId": "chunk-1", "audioHash": "hash-1"}],
            }

    client = FlakyClient()
    tool_trace: dict[str, object] = {
        "followUpSearches": [],
        "rlmCitationExpansions": [],
        "metadataLookups": [],
        "toolCalls": [],
    }
    effective_workload_config = rlm_adapter_module._resolve_effective_workload_config(
        retrieval={"top_k": 3},
        execution={},
    )
    tools = rlm_adapter_module._build_rlm_tools(
        client=client,
        catalog_id="catalog-1",
        effective_workload_config=effective_workload_config,
        task_id="task_1",
        tool_trace=tool_trace,
    )
    tools_by_name = {tool.name: tool.func for tool in tools}

    with rlm_adapter_module.active_task("task_1"):
        result = tools_by_name["search_catalog"]("test query", 3)

    assert client.calls == 2
    assert result["results"][0]["chunkId"] == "chunk-1"
    assert tool_trace["toolCalls"][-1] == {
        "tool": "search_catalog",
        "args": {
            "query": "test query",
            "top_k": 3,
            "include_neighbors": True,
            "neighbor_count": 1,
        },
        "status": "ok",
        "attempts": 1,
        "resultCount": 1,
        "textCharCount": 0,
        "contextCharCount": 0,
        "uniqueChunkCount": 1,
        "uniqueAudioHashCount": 1,
        "duplicateChunkCount": 0,
    }


def test_rlm_tool_trace_summarizes_evidence_coverage() -> None:
    tool_trace: dict[str, object] = {
        "followUpSearches": [],
        "rlmCitationExpansions": [],
        "metadataLookups": [],
        "toolCalls": [],
    }

    rlm_adapter_module._record_tool_success(
        tool_trace=tool_trace,
        tool_name="search_catalog",
        args={
            "query": "test query",
            "top_k": 3,
            "include_neighbors": True,
            "neighbor_count": 1,
        },
        result={
            "results": [
                {
                    "chunkId": "chunk-1",
                    "audioHash": "hash-1",
                    "text": "abc",
                    "contextText": "abcdef",
                },
                {
                    "chunkId": "chunk-1",
                    "audioHash": "hash-1",
                    "text": "de",
                    "contextText": "gh",
                },
                {
                    "chunkId": "chunk-2",
                    "audioHash": "hash-2",
                    "text": "fghi",
                },
            ]
        },
    )
    rlm_adapter_module._record_tool_success(
        tool_trace=tool_trace,
        tool_name="get_chunk_window",
        args={"chunk_id": "chunk-1", "neighbor_count": 1},
        result={
            "chunk": {
                "chunkId": "chunk-1",
                "audioHash": "hash-1",
                "text": "main",
            },
            "neighbors": {
                "before": [{"chunkId": "chunk-0", "audioHash": "hash-1"}],
                "after": [{"chunkId": "chunk-2", "audioHash": "hash-2"}],
            },
            "contextText": "main context",
        },
    )

    follow_up = tool_trace["followUpSearches"][0]
    assert follow_up["textCharCount"] == 9
    assert follow_up["contextCharCount"] == 8
    assert follow_up["uniqueChunkCount"] == 2
    assert follow_up["uniqueAudioHashCount"] == 2
    assert follow_up["duplicateChunkCount"] == 1

    search_call = tool_trace["toolCalls"][0]
    assert search_call["textCharCount"] == 9
    assert search_call["uniqueChunkCount"] == 2

    window_call = tool_trace["toolCalls"][1]
    assert window_call["textCharCount"] == 4
    assert window_call["contextCharCount"] == 12
    assert window_call["neighborChunkCount"] == 2
    assert window_call["uniqueChunkCount"] == 3
    assert window_call["uniqueAudioHashCount"] == 2


def test_rlm_tool_wrappers_preserve_retryable_error_metadata(monkeypatch) -> None:
    class FailingClient:
        def search_catalog(
            self,
            *,
            catalog_id: str,
            query: str,
            top_k: int,
            include_neighbors: bool,
            neighbor_count: int,
        ) -> dict[str, object]:
            raise rlm_adapter_module.DeepSearchClientError(
                "Internal deep-search request timed out.",
                status_code=504,
            )

    tool_trace: dict[str, object] = {
        "followUpSearches": [],
        "rlmCitationExpansions": [],
        "metadataLookups": [],
        "toolCalls": [],
    }
    effective_workload_config = rlm_adapter_module._resolve_effective_workload_config(
        retrieval={},
        execution={},
    )
    tools = rlm_adapter_module._build_rlm_tools(
        client=FailingClient(),
        catalog_id="catalog-1",
        effective_workload_config=effective_workload_config,
        task_id="task_1",
        tool_trace=tool_trace,
    )
    tools_by_name = {tool.name: tool.func for tool in tools}

    with pytest.raises(rlm_adapter_module.DeepSearchClientError) as exc_info:
        with rlm_adapter_module.active_task("task_1"):
            tools_by_name["search_catalog"]("test query", 5)

    assert exc_info.value.status_code == 504
    assert " 504" in str(exc_info.value)
    assert rlm_adapter_module.is_retryable_tool_error(
        {
            "metadata": [
                {
                    "event_type": "tool.error",
                    "data": {"error_message": str(exc_info.value)},
                }
            ]
        }
    )
    assert len(tool_trace["toolCalls"]) == 3
    assert tool_trace["toolCalls"][-1] == {
        "tool": "search_catalog",
        "args": {
            "query": "test query",
            "top_k": 5,
            "include_neighbors": True,
            "neighbor_count": 1,
        },
        "status": "error",
        "attempts": 1,
        "statusCode": 504,
        "error": "Internal deep-search request timed out.",
    }


def test_run_initial_retrieval_surfaces_upstream_besedy_error(monkeypatch) -> None:
    server, thread, _requests = _start_fake_besedy_server(
        search_status=404,
        search_payload={"error": "ColBERT bundle not found for catalog"},
    )
    try:
        monkeypatch.setenv(
            "BESEDY_INTERNAL_BASE_URL", f"http://127.0.0.1:{server.server_address[1]}"
        )
        monkeypatch.setenv("BESEDY_JOB_SERVICE_SECRET", "jobs-secret")
        monkeypatch.setenv("BESEDY_INTERNAL_TIMEOUT_MS", "2000")

        inputs = deep_search_flow_module.validate_inputs.fn(
            catalog_id="catalog-1",
            query="broken query",
            instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
            retrieval={},
            execution={},
        )

        with pytest.raises(RuntimeError, match="ColBERT bundle not found for catalog"):
            deep_search_flow_module.run_initial_retrieval.fn(inputs)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_run_initial_retrieval_marks_404_as_non_retryable(monkeypatch) -> None:
    class FailingClient:
        def search_catalog(
            self,
            *,
            catalog_id: str,
            query: str,
            top_k: int,
            include_neighbors: bool,
            neighbor_count: int,
        ) -> dict[str, object]:
            raise deep_search_flow_module.DeepSearchClientError(
                "ColBERT bundle not found for catalog",
                status_code=404,
            )

    monkeypatch.setattr(
        deep_search_flow_module,
        "build_besedy_deep_search_client_from_env",
        lambda: FailingClient(),
    )
    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="broken query",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={},
    )

    with pytest.raises(deep_search_flow_module.DeepSearchFlowError) as exc_info:
        deep_search_flow_module.run_initial_retrieval.fn(inputs)

    assert (
        str(exc_info.value) == "Deep-search retrieval failed: ColBERT bundle not found for catalog"
    )
    assert exc_info.value.status_code == 404
    assert exc_info.value.retryable is False


def test_run_initial_retrieval_marks_504_as_retryable(monkeypatch) -> None:
    class FailingClient:
        def search_catalog(
            self,
            *,
            catalog_id: str,
            query: str,
            top_k: int,
            include_neighbors: bool,
            neighbor_count: int,
        ) -> dict[str, object]:
            raise deep_search_flow_module.DeepSearchClientError(
                "Internal deep-search request timed out.",
                status_code=504,
            )

    monkeypatch.setattr(
        deep_search_flow_module,
        "build_besedy_deep_search_client_from_env",
        lambda: FailingClient(),
    )
    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="slow query",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={},
    )

    with pytest.raises(deep_search_flow_module.DeepSearchFlowError) as exc_info:
        deep_search_flow_module.run_initial_retrieval.fn(inputs)

    assert (
        str(exc_info.value)
        == "Deep-search retrieval failed: Internal deep-search request timed out."
    )
    assert exc_info.value.status_code == 504
    assert exc_info.value.retryable is True


def test_expand_citations_preserves_partial_trace_on_failure(monkeypatch) -> None:
    class CitationClient:
        def __init__(self) -> None:
            self.calls = 0

        def get_chunk_window(
            self,
            *,
            catalog_id: str,
            chunk_id: str,
            neighbor_count: int,
        ) -> dict[str, object]:
            self.calls += 1
            if self.calls == 1:
                return {
                    "catalogId": catalog_id,
                    "chunk": {
                        "chunkId": chunk_id,
                        "audioHash": "hash-1",
                        "startSec": 10,
                        "endSec": 20,
                        "text": "context for chunk-1",
                    },
                    "contextText": "expanded context for chunk-1",
                    "metadata": {},
                }
            raise deep_search_flow_module.DeepSearchClientError(
                "Citation lookup timed out.",
                status_code=504,
            )

    monkeypatch.setattr(
        deep_search_flow_module,
        "build_besedy_deep_search_client_from_env",
        lambda: CitationClient(),
    )
    inputs = deep_search_flow_module.validate_inputs.fn(
        catalog_id="catalog-1",
        query="test query",
        instructions=TEST_DEEP_SEARCH_INSTRUCTIONS,
        retrieval={},
        execution={"citation_limit": 2, "citation_neighbor_count": 1},
    )
    initial_retrieval = {
        "query": "test query",
        "retrieval": {},
        "timings": {},
        "hits": [
            {"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"},
            {"chunkId": "chunk-2", "audioHash": "hash-2", "text": "secondary evidence"},
        ],
        "stub": False,
    }

    with pytest.raises(deep_search_flow_module.DeepSearchFlowError) as exc_info:
        deep_search_flow_module.expand_citations.fn(inputs, initial_retrieval)

    partial = exc_info.value.partial_result
    assert exc_info.value.retryable is True
    assert partial is not None
    assert partial["failedStage"] == "citation_expansion"
    assert partial["failedChunkId"] == "chunk-2"
    assert len(partial["citationExpansions"]) == 1
    assert partial["citationExpansions"][0]["chunk"]["chunkId"] == "chunk-1"


def test_deep_search_flow_persists_partial_bundle_on_citation_failure(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        monkeypatch.setenv("DEEP_SEARCH_OUTPUT_DIR", tmp_dir)
        monkeypatch.setenv("DEEP_SEARCH_EXECUTION_MODE", "retrieval")
        fake_context = SimpleNamespace(flow_run=SimpleNamespace(id="flow-run-1"))
        inputs = {
            "catalog_id": "catalog-1",
            "query": "test query",
            "retrieval": {},
            "execution": {},
        }
        initial_retrieval = {
            "query": "test query",
            "retrieval": {},
            "timings": {},
            "hits": [
                {"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"},
                {"chunkId": "chunk-2", "audioHash": "hash-2", "text": "secondary evidence"},
            ],
            "stub": False,
        }
        failure = deep_search_flow_module.DeepSearchFlowError(
            "Deep-search citation expansion failed: Citation lookup timed out.",
            status_code=504,
            retryable=True,
            partial_result={
                "initialRetrieval": initial_retrieval,
                "citationExpansions": [
                    {
                        "catalogId": "catalog-1",
                        "chunk": {"chunkId": "chunk-1"},
                        "contextText": "expanded context for chunk-1",
                        "metadata": {},
                    }
                ],
                "failedStage": "citation_expansion",
                "failedChunkId": "chunk-2",
            },
        )

        monkeypatch.setattr(deep_search_flow_module, "get_run_context", lambda: fake_context)
        monkeypatch.setattr(
            deep_search_flow_module,
            "validate_inputs",
            lambda **kwargs: inputs,
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "run_initial_retrieval",
            lambda _inputs: initial_retrieval,
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "expand_citations",
            lambda _inputs, _initial: (_ for _ in ()).throw(failure),
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "publish_prefect_artifacts",
            lambda **kwargs: None,
        )

        with pytest.raises(
            deep_search_flow_module.DeepSearchFlowError, match="Citation lookup timed out"
        ):
            deep_search_flow_module.deep_search_flow.fn(
                catalog_id="catalog-1",
                query="test query",
            )

        bundle_dir = Path(tmp_dir) / "flow-run-1"
        result = json.loads((bundle_dir / "result.json").read_text(encoding="utf-8"))
        assert result["trace"]["partial"] is True
        assert result["trace"]["failedStage"] == "citation_expansion"
        assert result["trace"]["failedChunkId"] == "chunk-2"
        assert len(result["trace"]["citationExpansions"]) == 1
        assert "## Failure" in result["markdown"]


def test_deep_search_flow_persists_rlm_partial_trace_on_failure(monkeypatch) -> None:
    with tempfile.TemporaryDirectory() as tmp_dir:
        monkeypatch.setenv("DEEP_SEARCH_OUTPUT_DIR", tmp_dir)
        fake_context = SimpleNamespace(flow_run=SimpleNamespace(id="flow-run-rlm"))
        inputs = {
            "catalog_id": "catalog-1",
            "query": "test query",
            "retrieval": {},
            "execution": {"mode": "rlm"},
        }
        initial_retrieval = {
            "query": "test query",
            "retrieval": {},
            "timings": {},
            "hits": [
                {"chunkId": "chunk-1", "audioHash": "hash-1", "text": "primary evidence"},
            ],
            "stub": False,
        }
        citation_expansions = [
            {
                "catalogId": "catalog-1",
                "chunk": {"chunkId": "chunk-1"},
                "contextText": "expanded context for chunk-1",
                "metadata": {},
            }
        ]
        failure = deep_search_flow_module.DeepSearchFlowError(
            "rlmbenchy execution failed: boom",
            partial_result={
                "initialRetrieval": initial_retrieval,
                "citationExpansions": citation_expansions,
                "failedStage": "rlm_execution",
                "traceExtras": {
                    "executionMode": "rlm",
                    "executor": "rlmbenchy_rlm",
                    "followUpSearches": [{"query": "more evidence"}],
                    "rlm": {"iterations": 2},
                },
            },
        )

        monkeypatch.setattr(deep_search_flow_module, "get_run_context", lambda: fake_context)
        monkeypatch.setattr(
            deep_search_flow_module,
            "validate_inputs",
            lambda **kwargs: inputs,
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "run_initial_retrieval",
            lambda _inputs: initial_retrieval,
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "expand_citations",
            lambda _inputs, _initial: citation_expansions,
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "run_rlm_deep_search",
            lambda **kwargs: (_ for _ in ()).throw(failure),
        )
        monkeypatch.setattr(
            deep_search_flow_module,
            "publish_prefect_artifacts",
            lambda **kwargs: None,
        )

        with pytest.raises(
            deep_search_flow_module.DeepSearchFlowError, match="rlmbenchy execution failed"
        ):
            deep_search_flow_module.deep_search_flow.fn(
                catalog_id="catalog-1",
                query="test query",
            )

        bundle_dir = Path(tmp_dir) / "flow-run-rlm"
        result = json.loads((bundle_dir / "result.json").read_text(encoding="utf-8"))
        assert result["trace"]["partial"] is True
        assert result["trace"]["executionMode"] == "rlm"
        assert result["trace"]["executor"] == "rlmbenchy_rlm"
        assert result["trace"]["failedStage"] == "rlm_execution"
        assert result["trace"]["followUpSearches"] == [{"query": "more evidence"}]
        assert result["trace"]["rlm"] == {"iterations": 2}
        assert result["report"]["title"] == "Deep Search (RLM Partial Failure)"
        assert result["markdown"].startswith("# Deep Search (RLM Partial Failure)")
