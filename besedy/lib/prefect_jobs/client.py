"""Prefect client adapter used by the Besedy jobs facade."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from prefect.client.orchestration import get_client
from prefect.client.schemas.actions import WorkPoolCreate
from prefect.client.schemas.filters import (
    ArtifactFilter,
    ArtifactFilterFlowRunId,
    ArtifactFilterType,
    FlowRunFilter,
    FlowRunFilterState,
    FlowRunFilterStateName,
    FlowRunFilterTags,
)
from prefect.client.schemas.sorting import ArtifactSort, FlowRunSort
from prefect.deployments import run_deployment
from prefect.states import Cancelling
from prefect.workers.process import ProcessWorker

from besedy.lib.job_records import JOB_RESULT_ARTIFACT_TYPE, validate_job_record

from .json_types import JsonDict


class PrefectJobsClient(Protocol):
    def ensure_process_work_pool(
        self,
        *,
        name: str,
        concurrency_limit: int | None,
    ) -> None: ...

    def create_deployment_run(
        self,
        *,
        deployment_name: str,
        parameters: JsonDict,
        flow_run_name: str,
        tags: list[str],
        idempotency_key: str | None = None,
    ) -> object: ...

    def read_flow_run(self, *, flow_run_id: str) -> object: ...

    def read_flow_runs(
        self,
        *,
        tags: list[str],
        limit: int,
        state_names: list[str] | None = None,
    ) -> Sequence[object]: ...

    def read_flow_run_states(self, *, flow_run_id: str) -> Sequence[object]: ...

    def read_job_result(self, *, flow_run_id: str, attempt: int) -> JsonDict | None: ...

    def cancel_flow_run(self, *, flow_run_id: str) -> object: ...


@dataclass(slots=True)
class RuntimePrefectJobsClient:
    """Thin wrapper around Prefect's sync client and deployment helpers."""

    def ensure_process_work_pool(
        self,
        *,
        name: str,
        concurrency_limit: int | None,
    ) -> None:
        base_job_template = ProcessWorker.get_default_base_job_template()
        with get_client(sync_client=True) as client:
            client.create_work_pool(
                WorkPoolCreate(
                    name=name,
                    type="process",
                    base_job_template=base_job_template,
                    concurrency_limit=concurrency_limit,
                ),
                overwrite=True,
            )

    def create_deployment_run(
        self,
        *,
        deployment_name: str,
        parameters: JsonDict,
        flow_run_name: str,
        tags: list[str],
        idempotency_key: str | None = None,
    ) -> object:
        return run_deployment(
            deployment_name,
            parameters=parameters,
            flow_run_name=flow_run_name,
            timeout=0,
            as_subflow=False,
            tags=tags,
            idempotency_key=idempotency_key,
        )

    def read_flow_run(self, *, flow_run_id: str) -> object:
        with get_client(sync_client=True) as client:
            return client.read_flow_run(UUID(flow_run_id))

    def read_flow_runs(
        self,
        *,
        tags: list[str],
        limit: int,
        state_names: list[str] | None = None,
    ) -> Sequence[object]:
        flow_run_filter = FlowRunFilter()
        if tags:
            flow_run_filter.tags = FlowRunFilterTags(all_=tags)
        if state_names:
            flow_run_filter.state = FlowRunFilterState(
                name=FlowRunFilterStateName(any_=state_names)
            )
        with get_client(sync_client=True) as client:
            return client.read_flow_runs(
                flow_run_filter=flow_run_filter,
                sort=FlowRunSort.START_TIME_DESC,
                limit=limit,
            )

    def read_flow_run_states(self, *, flow_run_id: str) -> Sequence[object]:
        with get_client(sync_client=True) as client:
            return client.read_flow_run_states(UUID(flow_run_id))

    def read_job_result(self, *, flow_run_id: str, attempt: int) -> JsonDict | None:
        with get_client(sync_client=True) as client:
            artifacts = client.read_artifacts(
                artifact_filter=ArtifactFilter(
                    flow_run_id=ArtifactFilterFlowRunId(any_=[UUID(flow_run_id)]),
                    type=ArtifactFilterType(any_=[JOB_RESULT_ARTIFACT_TYPE]),
                ),
                sort=ArtifactSort.CREATED_DESC,
                limit=1,
            )
        if not artifacts:
            return None
        record = validate_job_record(artifacts[0].data)
        if (
            record is None or record["kind"] != "result"
            or type(record.get("attempt")) is not int or record["attempt"] != attempt
        ):
            return None
        return record

    def cancel_flow_run(self, *, flow_run_id: str) -> object:
        with get_client(sync_client=True) as client:
            return client.set_flow_run_state(UUID(flow_run_id), Cancelling())
