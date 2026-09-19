#!/usr/bin/env python3
"""Register the Prefect work pools and the deep-search and ingest deployments."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

from prefect.flows import EntrypointType

if __package__ in {None, ""}:  # pragma: no cover - direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from besedy.lib.prefect_jobs.client import RuntimePrefectJobsClient
    from besedy.lib.prefect_jobs.flows.deep_search import deep_search_flow
    from besedy.lib.prefect_jobs.flows.ingest_recording import ingest_recording_flow
    from besedy.lib.prefect_jobs.flows.remove_recording import remove_recording_flow
    from besedy.lib.prefect_jobs.models import JobKind, job_kind_tag
else:  # pragma: no branch
    from .client import RuntimePrefectJobsClient
    from .flows.deep_search import deep_search_flow
    from .flows.ingest_recording import ingest_recording_flow
    from .flows.remove_recording import remove_recording_flow
    from .models import JobKind, job_kind_tag


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--work-pool",
        default=os.getenv("PREFECT_DEEP_SEARCH_WORK_POOL", "besedy-deep-search"),
    )
    parser.add_argument(
        "--deployment-name",
        default=os.getenv("PREFECT_DEEP_SEARCH_DEPLOYMENT_NAME", "deep-search-default"),
    )
    parser.add_argument(
        "--concurrency-limit",
        type=int,
        default=int(os.getenv("PREFECT_DEEP_SEARCH_CONCURRENCY_LIMIT", "10")),
    )
    parser.add_argument(
        "--ingest-work-pool",
        default=os.getenv("PREFECT_INGEST_WORK_POOL", "besedy-ingest"),
    )
    parser.add_argument(
        "--ingest-deployment-name",
        default=os.getenv("PREFECT_INGEST_DEPLOYMENT_NAME", "ingest-default"),
    )
    parser.add_argument(
        "--ingest-concurrency-limit",
        type=int,
        default=int(os.getenv("PREFECT_INGEST_CONCURRENCY_LIMIT", "1")),
    )
    parser.add_argument(
        "--ingest-remove-deployment-name",
        default=os.getenv("PREFECT_INGEST_REMOVE_DEPLOYMENT_NAME", "ingest-remove-default"),
    )
    args = parser.parse_args(argv)

    client = RuntimePrefectJobsClient()
    _register(
        client=client,
        flow=deep_search_flow,
        work_pool=args.work_pool,
        deployment_name=args.deployment_name,
        concurrency_limit=args.concurrency_limit,
        kind=JobKind.DEEP_SEARCH,
    )
    _register(
        client=client,
        flow=ingest_recording_flow,
        work_pool=args.ingest_work_pool,
        deployment_name=args.ingest_deployment_name,
        concurrency_limit=args.ingest_concurrency_limit,
        kind=JobKind.INGEST,
    )
    # Removal shares the ingest pool (same host, same catalog lock) so the pool
    # is only ensured once; the deployment gets the same concurrency limit.
    _register(
        client=client,
        flow=remove_recording_flow,
        work_pool=args.ingest_work_pool,
        deployment_name=args.ingest_remove_deployment_name,
        concurrency_limit=args.ingest_concurrency_limit,
        kind=JobKind.INGEST,
        ensure_pool=False,
    )
    return 0


def _register(
    *,
    client: RuntimePrefectJobsClient,
    flow: Any,
    work_pool: str,
    deployment_name: str,
    concurrency_limit: int,
    kind: JobKind,
    ensure_pool: bool = True,
) -> None:
    limit = max(1, concurrency_limit)
    if ensure_pool:
        client.ensure_process_work_pool(name=work_pool, concurrency_limit=limit)
    deployment = flow.to_deployment(
        name=deployment_name,
        work_pool_name=work_pool,
        parameters={},
        tags=[job_kind_tag(kind)],
        concurrency_limit=limit,
        entrypoint_type=EntrypointType.MODULE_PATH,
    )
    deployment.apply(work_pool_name=work_pool)


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main())
