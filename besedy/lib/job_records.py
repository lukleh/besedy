"""Versioned records shared by catalog subprocesses and job-result recovery."""

from __future__ import annotations

import json
import os
from typing import Any, Literal, cast

JOB_RECORDS_ENV = "BESEDY_JOB_RECORDS"
JOB_RESULT_ARTIFACT_TYPE = "besedy-job-result"
JobPayload = dict[str, Any]


def job_record(kind: Literal["progress", "result"], payload: JobPayload) -> JobPayload:
    return {"protocol": "besedy-job", "version": 1, "kind": kind, "payload": payload}


def validate_job_record(value: object) -> JobPayload | None:
    if not isinstance(value, dict):
        return None
    value = cast(JobPayload, value)
    if (
        value.get("protocol") != "besedy-job"
        or type(value.get("version")) is not int
        or value["version"] != 1
    ):
        return None
    if value.get("kind") not in ("progress", "result"):
        return None
    payload = value.get("payload")
    if not isinstance(payload, dict):
        return None
    if value["kind"] == "progress":
        label, step, total = (payload.get(key) for key in ("label", "step", "total"))
        if not isinstance(label, str) or not label.strip():
            return None
        if step is not None or total is not None:
            if type(step) is not int or type(total) is not int or not 0 < step <= total:
                return None
    return value


def parse_job_record(line: str) -> JobPayload | None:
    """Decode one complete JSON line; human diagnostics have no protocol meaning."""
    if not line.lstrip().startswith("{"):
        return None
    try:
        return validate_job_record(json.loads(line))
    except json.JSONDecodeError:
        return None


def emit_job_record(kind: Literal["progress", "result"], payload: JobPayload) -> bool:
    """Opt workers into JSON lines while preserving the operator CLI output."""
    if os.getenv(JOB_RECORDS_ENV) != "1":
        return False
    print(json.dumps(job_record(kind, payload), ensure_ascii=False), flush=True)
    return True
