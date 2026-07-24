#!/usr/bin/env python3
"""HTTP entrypoint for the Prefect-backed jobs API facade."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

if __package__ in {None, ""}:  # pragma: no cover - direct script execution
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from besedy.lib.http_server import serve_threading_http_server
    from besedy.lib.prefect_jobs.api import PrefectJobsApiService, create_handler
else:  # pragma: no branch
    from ..http_server import serve_threading_http_server
    from .api import PrefectJobsApiService, create_handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.getenv("JOBS_SERVICE_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("JOBS_SERVICE_PORT", "8390")))
    args = parser.parse_args(argv)

    service = PrefectJobsApiService()
    serve_threading_http_server(
        host=args.host,
        port=args.port,
        handler=create_handler(service),
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entrypoint
    raise SystemExit(main())
