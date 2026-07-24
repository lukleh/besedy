#!/usr/bin/env python3
"""Register the Prefect work pool and deep-search deployment."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, cast

from prefect.flows import EntrypointType

if __package__ in {None, ""}:  # pragma: no cover - direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from besedy.lib.prefect_jobs.client import RuntimePrefectJobsClient
    from besedy.lib.prefect_jobs.flows.deep_search import deep_search_flow
else:  # pragma: no branch
    from .client import RuntimePrefectJobsClient
    from .flows.deep_search import deep_search_flow


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
    args = parser.parse_args(argv)

    client = RuntimePrefectJobsClient()
    client.ensure_process_work_pool(
        name=args.work_pool,
        concurrency_limit=max(1, args.concurrency_limit),
    )

    deployment = deep_search_flow.to_deployment(
        name=args.deployment_name,
        work_pool_name=args.work_pool,
        parameters={},
        tags=["job-kind:deep-search"],
        concurrency_limit=max(1, args.concurrency_limit),
        entrypoint_type=EntrypointType.MODULE_PATH,
    )
    cast(Any, deployment).apply(work_pool_name=args.work_pool)
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main())
