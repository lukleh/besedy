"""HTTP-facing Besedy jobs facade backed by Prefect flow runs."""

from __future__ import annotations

import os
import re
from collections.abc import Callable
from http import HTTPStatus
from typing import Any, TypeVar
from urllib.parse import parse_qs, urlparse

from prefect.exceptions import ObjectNotFound

from besedy.lib.http_server import JsonApiHandler

from .client import PrefectJobsClient, RuntimePrefectJobsClient
from .models import (
    CorrectionIndexSyncRequest,
    IngestRemovalRequest,
    IngestSubmitRequest,
    JobKind,
    JobStatus,
    build_correction_index_flow_run_name,
    build_correction_index_flow_run_tags,
    build_ingest_flow_run_name,
    build_ingest_flow_run_tags,
    job_kind_from_tags,
    job_kind_tag,
    normalize_flow_run,
    normalize_flow_run_history,
    prefect_state_names_for_job_status,
    require_archive_id,
    sanitize_tag_value,
    validate_deployment_catalog_id,
)

T = TypeVar("T")

_INGEST_SUBMIT_ROUTE = re.compile(r"^/catalogs/(?P<catalog_id>[^/]+)/ingest/jobs$")
_INGEST_REMOVAL_ROUTE = re.compile(r"^/catalogs/(?P<catalog_id>[^/]+)/ingest/removals$")
_CORRECTION_INDEX_ROUTE = re.compile(
    r"^/catalogs/(?P<catalog_id>[^/]+)/correction/index-sync/jobs$"
)
_JOB_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)$")
_JOB_HISTORY_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)/history$")
_JOB_CANCEL_ROUTE = re.compile(r"^/jobs/(?P<job_id>[^/]+)/cancel$")


class PrefectJobsApiService:
    """Minimal typed jobs facade built on top of Prefect flow runs."""

    def __init__(
        self,
        *,
        client: PrefectJobsClient | None = None,
        ingest_deployment_name: str | None = None,
        ingest_remove_deployment_name: str | None = None,
        correction_index_deployment_name: str | None = None,
        prefect_ui_url: str | None = None,
    ) -> None:
        require_archive_id()
        self._client = client or RuntimePrefectJobsClient()
        self._ingest_deployment_name = ingest_deployment_name or os.getenv(
            "PREFECT_INGEST_FULL_DEPLOYMENT_NAME",
            "ingest_recording_flow/ingest-default",
        )
        self._ingest_remove_deployment_name = ingest_remove_deployment_name or os.getenv(
            "PREFECT_INGEST_REMOVE_FULL_DEPLOYMENT_NAME",
            "remove_recording_flow/ingest-remove-default",
        )
        self._correction_index_deployment_name = correction_index_deployment_name or os.getenv(
            "PREFECT_CORRECTION_INDEX_FULL_DEPLOYMENT_NAME",
            "sync_correction_index_flow/correction-index-default",
        )
        self._prefect_ui_url = (
            prefect_ui_url or os.getenv("PREFECT_UI_URL") or os.getenv("PREFECT_UI_API_URL")
        )

    def health(self) -> dict[str, Any]:
        return {"ready": True, "service": "jobs-api", "orchestrator": "prefect"}

    def submit_ingest(self, *, catalog_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = IngestSubmitRequest.from_payload(payload)
        parameters = request.to_flow_parameters(catalog_id=catalog_id)
        flow_run = self._client.create_deployment_run(
            deployment_name=self._ingest_deployment_name,
            parameters=parameters,
            flow_run_name=build_ingest_flow_run_name(
                catalog_id=catalog_id,
                intake_id=request.intake_id,
            ),
            tags=build_ingest_flow_run_tags(
                catalog_id=catalog_id,
                intake_id=request.intake_id,
                requested_by_id=request.requested_by_id,
            ),
            idempotency_key=f"ingest:{request.intake_id}",
        )
        return normalize_flow_run(flow_run)

    def submit_ingest_removal(self, *, catalog_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = IngestRemovalRequest.from_payload(payload)
        parameters = request.to_flow_parameters(catalog_id=catalog_id)
        flow_run = self._client.create_deployment_run(
            deployment_name=self._ingest_remove_deployment_name,
            parameters=parameters,
            flow_run_name=build_ingest_flow_run_name(
                catalog_id=catalog_id,
                intake_id=request.intake_id,
                operation="remove",
            ),
            tags=build_ingest_flow_run_tags(
                catalog_id=catalog_id,
                intake_id=request.intake_id,
                requested_by_id=request.requested_by_id,
                operation="remove",
            ),
            idempotency_key=(
                f"ingest-remove:{request.intake_id}:{request.audio_hash}:{request.idempotency_key}"
            ),
        )
        return normalize_flow_run(flow_run)

    def submit_correction_index_sync(
        self, *, catalog_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        request = CorrectionIndexSyncRequest.from_payload(payload)
        parameters = request.to_flow_parameters(catalog_id=catalog_id)
        flow_run = self._client.create_deployment_run(
            deployment_name=self._correction_index_deployment_name,
            parameters=parameters,
            flow_run_name=build_correction_index_flow_run_name(
                catalog_id=catalog_id,
                audio_hash=request.audio_hash,
                operation=request.operation,
            ),
            tags=build_correction_index_flow_run_tags(
                catalog_id=catalog_id,
                audio_hash=request.audio_hash,
                operation=request.operation,
                requested_by_id=request.requested_by_id,
            ),
            idempotency_key=request.idempotency_key,
        )
        return normalize_flow_run(flow_run)

    def list_jobs(self, *, raw_query: str) -> dict[str, Any]:
        params = parse_qs(raw_query, keep_blank_values=False)
        kind = _parse_job_kind(_first_param(params, "kind")) or JobKind.INGEST
        status = _parse_job_status(_first_param(params, "status"))
        catalog_id = _first_param(params, "catalogId")
        archive_id = require_archive_id()
        if catalog_id:
            validate_deployment_catalog_id(catalog_id)
        requested_by_id = _first_param(params, "requestedById")
        limit_raw = _first_param(params, "limit")
        limit = int(limit_raw) if limit_raw is not None else 50
        if limit <= 0:
            raise ValueError("limit must be positive.")

        tags = [job_kind_tag(kind), f"catalog:{archive_id}"]
        if requested_by_id:
            tags.append(f"requested-by:{sanitize_tag_value(requested_by_id)}")

        jobs = [
            normalize_flow_run(flow_run)
            for flow_run in self._client.read_flow_runs(
                tags=tags,
                limit=limit,
                state_names=prefect_state_names_for_job_status(status)
                if status is not None
                else None,
            )
            if job_kind_from_tags(getattr(flow_run, "tags", None)) == kind
        ]
        return {"jobs": [job for job in jobs if job.get("catalog_id") == archive_id]}

    def get_job(self, *, job_id: str) -> dict[str, Any]:
        archive_id = require_archive_id()
        flow_run = _not_found_as_404(lambda: self._client.read_flow_run(flow_run_id=job_id))
        job = normalize_flow_run(flow_run)
        if job.get("catalog_id") != archive_id:
            raise FileNotFoundError("Job not found.")
        # Fetch recovery data only for a terminal ingest run that can need it.
        # Scope/authorization checks above happen before reading its artifact.
        if job.get("kind") == JobKind.INGEST.value and job.get("status") == JobStatus.FAILED.value:
            job["result"] = self._client.read_job_result(
                flow_run_id=job_id, attempt=getattr(flow_run, "run_count", 0)
            )
        return job

    def get_history(self, *, job_id: str) -> dict[str, Any]:
        self.get_job(job_id=job_id)
        states = _not_found_as_404(lambda: self._client.read_flow_run_states(flow_run_id=job_id))
        return normalize_flow_run_history(
            flow_run_id=job_id,
            states=states,
            prefect_ui_url=self._prefect_ui_url,
        )

    def cancel_job(self, *, job_id: str) -> dict[str, Any]:
        self.get_job(job_id=job_id)
        _not_found_as_404(lambda: self._client.cancel_flow_run(flow_run_id=job_id))
        flow_run = _not_found_as_404(lambda: self._client.read_flow_run(flow_run_id=job_id))
        return normalize_flow_run(flow_run)


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
            ingest_match = _INGEST_SUBMIT_ROUTE.match(parsed.path)
            if ingest_match is not None:
                self._dispatch_json(
                    lambda: service.submit_ingest(
                        catalog_id=ingest_match.group("catalog_id"),
                        payload=self._read_json_payload(),
                    )
                )
                return

            removal_match = _INGEST_REMOVAL_ROUTE.match(parsed.path)
            if removal_match is not None:
                self._dispatch_json(
                    lambda: service.submit_ingest_removal(
                        catalog_id=removal_match.group("catalog_id"),
                        payload=self._read_json_payload(),
                    )
                )
                return

            correction_match = _CORRECTION_INDEX_ROUTE.match(parsed.path)
            if correction_match is not None:
                self._dispatch_json(
                    lambda: service.submit_correction_index_sync(
                        catalog_id=correction_match.group("catalog_id"),
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


def _not_found_as_404(operation: Callable[[], T]) -> T:
    """Surface a missing Prefect object as 404 instead of the generic 500."""
    try:
        return operation()
    except ObjectNotFound as exc:
        raise FileNotFoundError(f"Flow run not found: {exc}") from exc


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
