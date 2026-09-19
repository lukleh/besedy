#!/usr/bin/env python3
"""Production maintenance checks for Prefect-backed jobs."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from typing import Protocol

from prefect.client.orchestration import get_client
from prefect.client.schemas.filters import (
    FlowRunFilter,
    FlowRunFilterDeploymentId,
    FlowRunFilterState,
    FlowRunFilterStateType,
)
from prefect.client.schemas.objects import StateType
from prefect.client.schemas.sorting import FlowRunSort

ACTIVE_STATE_TYPES = [
    StateType.SCHEDULED,
    StateType.PENDING,
    StateType.RUNNING,
    StateType.PAUSED,
    StateType.CANCELLING,
]


class PrefectMaintenanceClient(Protocol):
    def read_deployment_by_name(self, name: str) -> object: ...

    def read_flow_runs(
        self,
        *,
        flow_run_filter: FlowRunFilter,
        sort: FlowRunSort,
        limit: int,
    ) -> Sequence[object]: ...


def read_active_deployment_runs(
    client: PrefectMaintenanceClient,
    *,
    deployment_name: str,
    limit: int = 20,
) -> Sequence[object]:
    deployment = client.read_deployment_by_name(deployment_name)
    deployment_id = getattr(deployment, "id")
    return client.read_flow_runs(
        flow_run_filter=FlowRunFilter(
            deployment_id=FlowRunFilterDeploymentId(any_=[deployment_id]),
            state=FlowRunFilterState(type=FlowRunFilterStateType(any_=ACTIVE_STATE_TYPES)),
        ),
        sort=FlowRunSort.START_TIME_ASC,
        limit=limit,
    )


def check_idle(*, deployment_name: str) -> int:
    with get_client(sync_client=True) as client:
        active_runs = read_active_deployment_runs(
            client,
            deployment_name=deployment_name,
        )

    if not active_runs:
        print(f"Prefect deployment is idle: {deployment_name}")
        return 0

    print(
        f"Refusing maintenance: {len(active_runs)} active Prefect run(s) found "
        f"for {deployment_name}:"
    )
    for run in active_runs:
        print(
            "  "
            f"{getattr(run, 'id', 'unknown')} "
            f"{getattr(run, 'state_name', 'unknown')} "
            f"{getattr(run, 'name', 'unnamed')}"
        )
    print("Wait for these runs to finish or cancel them explicitly, then retry.")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--deployment-name",
        default=os.getenv(
            "PREFECT_DEEP_SEARCH_FULL_DEPLOYMENT_NAME",
            "deep_search_flow/deep-search-prod",
        ),
    )
    args = parser.parse_args(argv)
    return check_idle(deployment_name=args.deployment_name)


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main())
