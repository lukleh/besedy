"""HTTP-facing Besedy jobs facade backed by Prefect flow runs."""

from __future__ import annotations

import os
import re
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from besedy.lib.http_server import JsonApiHandler

from .client import PrefectJobsClient, RuntimePrefectJobsClient
from .models import (
    DeepSearchSubmitRequest,
    JobKind,
    JobStatus,
    build_flow_run_name,
    build_flow_run_tags,
    normalize_flow_run,
    normalize_flow_run_history,
    prefect_state_names_for_job_status,
    sanitize_tag_value,
)

_SUBMIT_ROUTE = re.compile(r"^/catalogs/(?P<catalog_id>[^/]+)/deep-search/jobs$")
_JOB_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)$")
_JOB_HISTORY_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)/history$")
_JOB_CANCEL_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)/cancel$")


class PrefectJobsApiService:
    """Minimal typed jobs facade built on top of Prefect flow runs."""

    def __init__(
        self,
        *,
        client: PrefectJobsClient | None = None,
        output_root_dir: Path | None = None,
        deployment_name: str | None = None,
        prefect_ui_url: str | None = None,
    ) -> None:
        self._client = client or RuntimePrefectJobsClient()
        self._output_root_dir = (
            output_root_dir
            or Path(os.getenv("DEEP_SEARCH_OUTPUT_DIR", "tmp/deep-search")).resolve()
        )
        self._deployment_name = deployment_name or os.getenv(
            "PREFECT_DEEP_SEARCH_FULL_DEPLOYMENT_NAME",
            "deep_search_flow/deep-search-default",
        )
        self._prefect_ui_url = (
            prefect_ui_url or os.getenv("PREFECT_UI_URL") or os.getenv("PREFECT_UI_API_URL")
        )

    def health(self) -> dict[str, Any]:
        return {"ready": True, "service": "jobs-api", "orchestrator": "prefect"}

    def submit_deep_search(self, *, catalog_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = DeepSearchSubmitRequest.from_payload(payload)
        parameters = request.to_flow_parameters(catalog_id=catalog_id)
        flow_run = self._client.create_deep_search_run(
            deployment_name=self._deployment_name,
            parameters=parameters,
            flow_run_name=build_flow_run_name(catalog_id=catalog_id, query=request.query),
            tags=build_flow_run_tags(
                catalog_id=catalog_id,
                requested_by_id=request.requested_by_id,
                caller_scope=request.caller_scope or request.requested_by_id,
            ),
            idempotency_key=_string_or_none(payload.get("idempotencyKey")),
        )
        return normalize_flow_run(flow_run, output_root_dir=self._output_root_dir)

    def list_jobs(self, *, raw_query: str) -> dict[str, Any]:
        params = parse_qs(raw_query, keep_blank_values=False)
        kind = _parse_job_kind(_first_param(params, "kind"))
        status = _parse_job_status(_first_param(params, "status"))
        catalog_id = _first_param(params, "catalogId")
        requested_by_id = _first_param(params, "requestedById")
        limit_raw = _first_param(params, "limit")
        limit = int(limit_raw) if limit_raw is not None else 50
        if limit <= 0:
            raise ValueError("limit must be positive.")

        tags = ["job-kind:deep-search"]
        if catalog_id:
            tags.append(f"catalog:{sanitize_tag_value(catalog_id, fallback='catalog')}")
        if requested_by_id:
            tags.append(f"requested-by:{sanitize_tag_value(requested_by_id)}")

        jobs = [
            normalize_flow_run(flow_run, output_root_dir=self._output_root_dir)
            for flow_run in self._client.read_flow_runs(
                tags=tags,
                limit=limit,
                state_names=prefect_state_names_for_job_status(status)
                if status is not None
                else None,
            )
        ]
        if kind is not None:
            jobs = [job for job in jobs if job["kind"] == kind.value]
        return {"jobs": jobs}

    def get_job(self, *, job_id: str) -> dict[str, Any]:
        flow_run = self._client.read_flow_run(flow_run_id=job_id)
        return normalize_flow_run(flow_run, output_root_dir=self._output_root_dir)

    def get_history(self, *, job_id: str) -> dict[str, Any]:
        states = self._client.read_flow_run_states(flow_run_id=job_id)
        return normalize_flow_run_history(
            flow_run_id=job_id,
            states=states,
            output_root_dir=self._output_root_dir,
            prefect_ui_url=self._prefect_ui_url,
        )

    def cancel_job(self, *, job_id: str) -> dict[str, Any]:
        self._client.cancel_flow_run(flow_run_id=job_id)
        flow_run = self._client.read_flow_run(flow_run_id=job_id)
        return normalize_flow_run(flow_run, output_root_dir=self._output_root_dir)


def create_handler(service: PrefectJobsApiService):
    class PrefectJobsApiHandler(JsonApiHandler):
        server_version = "BesedyPrefectJobs/1.0"

        def _authorize_non_health(self) -> bool:
            expected = os.getenv("BESEDY_JOB_SERVICE_SECRET", "").strip()
            auth_header = self.headers.get("Authorization")
            if not expected or auth_header != f"Bearer {expected}":
                self._write_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._write_json(HTTPStatus.OK, service.health())
                return
            if not self._authorize_non_health():
                return
            if parsed.path == "/jobs":
                self._dispatch_json(lambda: service.list_jobs(raw_query=parsed.query))
                return
            history_match = _JOB_HISTORY_ROUTE.match(parsed.path)
            if history_match is not None:
                self._dispatch_json(
                    lambda: service.get_history(job_id=history_match.group("job_id"))
                )
                return
            job_match = _JOB_ROUTE.match(parsed.path)
            if job_match is not None:
                self._dispatch_json(lambda: service.get_job(job_id=job_match.group("job_id")))
                return
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if not self._authorize_non_health():
                return
            submit_match = _SUBMIT_ROUTE.match(parsed.path)
            if submit_match is not None:
                self._dispatch_json(
                    lambda: service.submit_deep_search(
                        catalog_id=submit_match.group("catalog_id"),
                        payload=self._read_json_payload(),
                    )
                )
                return

            cancel_match = _JOB_CANCEL_ROUTE.match(parsed.path)
            if cancel_match is not None:
                self._dispatch_json(lambda: service.cancel_job(job_id=cancel_match.group("job_id")))
                return

            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    return PrefectJobsApiHandler


def _first_param(params: dict[str, list[str]], key: str) -> str | None:
    values = params.get(key)
    if not values:
        return None
    value = values[0].strip()
    return value or None


def _parse_job_kind(value: str | None) -> JobKind | None:
    if value is None:
        return None
    try:
        return JobKind(value)
    except ValueError as exc:
        raise ValueError(f"Unsupported kind: {value}") from exc


def _parse_job_status(value: str | None) -> JobStatus | None:
    if value is None:
        return None
    try:
        return JobStatus(value)
    except ValueError as exc:
        raise ValueError(f"Unsupported status: {value}") from exc


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    return rendered or None
