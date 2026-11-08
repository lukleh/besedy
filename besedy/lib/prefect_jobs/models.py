"""Typed models and normalization helpers for Prefect-backed jobs."""

from __future__ import annotations

import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from .json_types import JsonDict

_SANITIZE_TAG_RE = re.compile(r"[^a-z0-9._:-]+")


class JobKind(StrEnum):
    INGEST = "INGEST"
    CORRECTION_INDEX = "CORRECTION_INDEX"


JOB_KIND_TAGS: dict[JobKind, str] = {
    JobKind.INGEST: "job-kind:ingest",
    JobKind.CORRECTION_INDEX: "job-kind:correction-index",
}


def job_kind_tag(kind: JobKind) -> str:
    return JOB_KIND_TAGS[kind]


def job_kind_from_tags(tags: object) -> JobKind | None:
    """Accept only one explicit supported kind; historical runs stay unsupported."""
    if isinstance(tags, list | tuple | set):
        rendered = {str(tag) for tag in tags if str(tag).startswith("job-kind:")}
        if len(rendered) != 1:
            return None
        for kind, tag in JOB_KIND_TAGS.items():
            if tag in rendered:
                return kind
    return None


class JobStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


def prefect_state_names_for_job_status(status: JobStatus) -> list[str]:
    if status == JobStatus.QUEUED:
        return ["Scheduled", "Pending", "Late"]
    if status == JobStatus.RUNNING:
        return ["Running", "Cancelling", "Paused"]
    if status == JobStatus.SUCCEEDED:
        return ["Completed"]
    if status == JobStatus.FAILED:
        return ["Failed", "Crashed", "TimedOut"]
    if status == JobStatus.CANCELLED:
        return ["Cancelled"]
    return []


_CATALOG_ID_RE = re.compile(r"^\d{8}_\d{6}$")
_INTAKE_ID_RE = re.compile(r"^[a-z0-9]{16,64}$")
_AUDIO_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_IDEMPOTENCY_KEY_RE = re.compile(r"^[a-zA-Z0-9-]{16,64}$")
_FILENAME_FORBIDDEN_RE = re.compile(r"[/\\\x00]")
MAX_ORIGINAL_FILENAME_LENGTH = 255


def validate_catalog_id(value: object) -> str:
    rendered = str(value or "").strip()
    if not _CATALOG_ID_RE.fullmatch(rendered):
        raise ValueError("catalog_id must look like YYYYMMDD_HHMMSS.")
    return rendered


def require_archive_id() -> str:
    """Require the deployment's explicit archive before any job work."""
    raw = os.getenv("BESEDY_ARCHIVE_ID", "").strip()
    if not raw:
        raise ValueError("BESEDY_ARCHIVE_ID is required for deployment jobs.")
    if not _CATALOG_ID_RE.fullmatch(raw):
        raise ValueError("BESEDY_ARCHIVE_ID must look like YYYYMMDD_HHMMSS.")
    return raw


def validate_deployment_catalog_id(value: object) -> str:
    catalog_id = validate_catalog_id(value)
    if catalog_id != require_archive_id():
        raise ValueError("Catalog does not match this deployment's BESEDY_ARCHIVE_ID.")
    return catalog_id


def validate_intake_id(value: object) -> str:
    rendered = str(value or "").strip()
    if not _INTAKE_ID_RE.fullmatch(rendered):
        raise ValueError("intakeId must be a lowercase alphanumeric identifier.")
    return rendered


def validate_audio_hash(value: object) -> str:
    rendered = str(value or "").strip().lower()
    if not _AUDIO_HASH_RE.fullmatch(rendered):
        raise ValueError("audioHash must be a 64-character hex SHA-256 digest.")
    return rendered


def validate_idempotency_key(value: object) -> str:
    rendered = str(value or "").strip()
    if not _IDEMPOTENCY_KEY_RE.fullmatch(rendered):
        raise ValueError("idempotencyKey must be a stable UUID or intake identifier.")
    return rendered


CORRECTION_INDEX_OPERATIONS = frozenset({"publish", "withdraw", "rollback"})
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def validate_correction_index_operation(value: object) -> str:
    rendered = str(value or "").strip().lower()
    if rendered not in CORRECTION_INDEX_OPERATIONS:
        raise ValueError("operation must be publish, withdraw or rollback.")
    return rendered


_BACKEND_KEY_RE = re.compile(r"^[A-Za-z0-9._@-]+/[A-Za-z0-9._@-]+(/[A-Za-z0-9._@-]+)?$")


def validate_operation_token(value: object) -> str:
    """The publication or withdrawal id the sync is for; a UUID either way."""
    rendered = str(value or "").strip().lower()
    if not _UUID_RE.fullmatch(rendered):
        raise ValueError("operationToken must be a UUID.")
    return rendered


def validate_original_filename(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("originalFilename must be a string.")
    rendered = value.strip()
    if not rendered or rendered in {".", ".."}:
        raise ValueError("originalFilename must not be empty.")
    if len(rendered) > MAX_ORIGINAL_FILENAME_LENGTH:
        raise ValueError("originalFilename is too long.")
    if _FILENAME_FORBIDDEN_RE.search(rendered):
        raise ValueError("originalFilename must not contain path separators.")
    return rendered


@dataclass(slots=True, frozen=True)
class IngestSubmitRequest:
    intake_id: str
    original_filename: str
    requested_by_id: str

    @classmethod
    def from_payload(cls, payload: JsonDict) -> IngestSubmitRequest:
        requested_by_id = payload.get("requestedById")
        if not isinstance(requested_by_id, str) or not requested_by_id.strip():
            raise ValueError("requestedById is required and must be a non-empty string.")
        return cls(
            intake_id=validate_intake_id(payload.get("intakeId")),
            original_filename=validate_original_filename(payload.get("originalFilename")),
            requested_by_id=requested_by_id.strip(),
        )

    def to_flow_parameters(self, *, catalog_id: str) -> JsonDict:
        return {
            "catalog_id": validate_deployment_catalog_id(catalog_id),
            "intake_id": self.intake_id,
            "original_filename": self.original_filename,
            "requested_by_id": self.requested_by_id,
        }


@dataclass(slots=True, frozen=True)
class IngestRemovalRequest:
    intake_id: str
    audio_hash: str
    idempotency_key: str
    requested_by_id: str

    @classmethod
    def from_payload(cls, payload: JsonDict) -> IngestRemovalRequest:
        requested_by_id = payload.get("requestedById")
        if not isinstance(requested_by_id, str) or not requested_by_id.strip():
            raise ValueError("requestedById is required and must be a non-empty string.")
        return cls(
            intake_id=validate_intake_id(payload.get("intakeId")),
            audio_hash=validate_audio_hash(payload.get("audioHash")),
            idempotency_key=validate_idempotency_key(payload.get("idempotencyKey")),
            requested_by_id=requested_by_id.strip(),
        )

    def to_flow_parameters(self, *, catalog_id: str) -> JsonDict:
        return {
            "catalog_id": validate_deployment_catalog_id(catalog_id),
            "intake_id": self.intake_id,
            "audio_hash": self.audio_hash,
            "requested_by_id": self.requested_by_id,
        }


@dataclass(slots=True, frozen=True)
class CorrectionIndexSyncRequest:
    """Ask the host worker to carry one recording's correction into search.

    ``operation_token`` names the publication (publish, rollback) or the
    withdrawal generation (withdraw) the sync belongs to. ``attempt`` is part
    of the idempotency key so a retry after a failed run is a new flow run
    rather than the failed one handed back.
    """

    audio_hash: str
    operation: str
    operation_token: str
    requested_by_id: str | None
    attempt: int = 0
    # The search backend scope the web application indexes, so the sync builds
    # the same scope search queries rather than whatever the host defaults to.
    backend: str | None = None

    @classmethod
    def from_payload(cls, payload: JsonDict) -> CorrectionIndexSyncRequest:
        requested_by_id = payload.get("requestedById")
        attempt_raw = payload.get("attempt", 0)
        if not isinstance(attempt_raw, int) or isinstance(attempt_raw, bool) or attempt_raw < 0:
            raise ValueError("attempt must be a non-negative integer.")
        backend_raw = payload.get("backend")
        backend = (
            backend_raw.strip() if isinstance(backend_raw, str) and backend_raw.strip() else None
        )
        if backend is not None and not _BACKEND_KEY_RE.fullmatch(backend):
            raise ValueError("backend must be a '{workflow}/{model_component}' key.")
        return cls(
            audio_hash=validate_audio_hash(payload.get("audioHash")),
            operation=validate_correction_index_operation(payload.get("operation")),
            operation_token=validate_operation_token(payload.get("operationToken")),
            requested_by_id=(
                requested_by_id.strip()
                if isinstance(requested_by_id, str) and requested_by_id.strip()
                else None
            ),
            attempt=attempt_raw,
            backend=backend,
        )

    def to_flow_parameters(self, *, catalog_id: str) -> JsonDict:
        return {
            "catalog_id": validate_deployment_catalog_id(catalog_id),
            "audio_hash": self.audio_hash,
            "operation": self.operation,
            "operation_token": self.operation_token,
            "requested_by_id": self.requested_by_id,
            "backend": self.backend,
        }

    @property
    def idempotency_key(self) -> str:
        return f"correction-index:{self.operation}:{self.operation_token}:{self.attempt}"


def utcnow() -> datetime:
    return datetime.now(UTC)


def serialize_datetime(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def sanitize_tag_value(value: str | None, *, fallback: str = "unknown") -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return fallback
    normalized = _SANITIZE_TAG_RE.sub("-", raw).strip("-")
    return normalized or fallback


def build_ingest_flow_run_name(
    *, catalog_id: str, intake_id: str, operation: str = "ingest"
) -> str:
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    catalog = sanitize_tag_value(catalog_id, fallback="catalog")
    intake = sanitize_tag_value(intake_id[:12], fallback="intake")
    prefix = "ingest" if operation == "ingest" else f"ingest-{sanitize_tag_value(operation)}"
    return f"{prefix}-{catalog}-{intake}-{stamp}"


def build_ingest_flow_run_tags(
    *,
    catalog_id: str,
    intake_id: str,
    requested_by_id: str | None,
    operation: str = "ingest",
) -> list[str]:
    tags = [
        job_kind_tag(JobKind.INGEST),
        f"catalog:{sanitize_tag_value(catalog_id, fallback='catalog')}",
        f"intake:{sanitize_tag_value(intake_id, fallback='intake')}",
        f"operation:{sanitize_tag_value(operation, fallback='ingest')}",
    ]
    if requested_by_id:
        tags.append(f"requested-by:{sanitize_tag_value(requested_by_id)}")
    return tags


def build_correction_index_flow_run_name(
    *, catalog_id: str, audio_hash: str, operation: str
) -> str:
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    catalog = sanitize_tag_value(catalog_id, fallback="catalog")
    recording = sanitize_tag_value(audio_hash[:12], fallback="recording")
    return f"correction-{sanitize_tag_value(operation)}-{catalog}-{recording}-{stamp}"


def build_correction_index_flow_run_tags(
    *,
    catalog_id: str,
    audio_hash: str,
    operation: str,
    requested_by_id: str | None,
) -> list[str]:
    tags = [
        job_kind_tag(JobKind.CORRECTION_INDEX),
        f"catalog:{sanitize_tag_value(catalog_id, fallback='catalog')}",
        f"recording:{sanitize_tag_value(audio_hash, fallback='recording')}",
        f"operation:{sanitize_tag_value(operation, fallback='publish')}",
    ]
    if requested_by_id:
        tags.append(f"requested-by:{sanitize_tag_value(requested_by_id)}")
    return tags


def prefect_state_to_job_status(state_name: str | None, state_type: str | None) -> JobStatus:
    resolved_name = str(state_name or "").strip().lower()
    resolved_type = str(state_type or "").strip().upper()

    if resolved_name in {"scheduled", "pending", "late"} or resolved_type in {
        "SCHEDULED",
        "PENDING",
    }:
        return JobStatus.QUEUED
    if resolved_name in {"running", "cancelling", "paused"} or resolved_type in {
        "RUNNING",
        "CANCELLING",
        "PAUSED",
    }:
        return JobStatus.RUNNING
    if resolved_name == "completed" or resolved_type == "COMPLETED":
        return JobStatus.SUCCEEDED
    if resolved_name == "cancelled" or resolved_type == "CANCELLED":
        return JobStatus.CANCELLED
    if resolved_name in {"failed", "crashed", "timedout"} or resolved_type in {
        "FAILED",
        "CRASHED",
        "TIMEDOUT",
    }:
        return JobStatus.FAILED
    return JobStatus.QUEUED


def normalize_flow_run(flow_run: Any) -> JsonDict:
    kind = job_kind_from_tags(_value(flow_run, "tags"))
    if kind is None:
        raise FileNotFoundError("Unsupported job kind.")
    envelope = _flow_run_envelope(flow_run)
    if kind == JobKind.INGEST:
        return {**envelope, **_ingest_flow_run_fields(flow_run)}
    if kind == JobKind.CORRECTION_INDEX:
        return {**envelope, **_correction_index_flow_run_fields(flow_run)}
    raise FileNotFoundError("Unsupported job kind.")


def _flow_run_envelope(flow_run: Any) -> JsonDict:
    """Kind-independent projection of a Prefect flow run."""
    flow_run_id = str(_value(flow_run, "id"))
    state_name = _value(flow_run, "state_name")
    state_type = _value(flow_run, "state_type")
    parameters = _flow_run_parameters(flow_run)
    return {
        "id": flow_run_id,
        "status": prefect_state_to_job_status(str(state_name), str(state_type)).value,
        "requested_by_id": _string_or_none(parameters.get("requested_by_id")),
        "catalog_id": _string_or_none(parameters.get("catalog_id")),
        "error_code": None,
        "error_message": _state_message(flow_run),
        "progress_label": str(state_name or "") or None,
        "progress_pct": None,
        "created_at": serialize_datetime(_value(flow_run, "created")),
        "started_at": serialize_datetime(_value(flow_run, "start_time")),
        "finished_at": serialize_datetime(_value(flow_run, "end_time")),
        "updated_at": serialize_datetime(_value(flow_run, "updated")),
        "prefectStateName": str(state_name or "") or None,
        "prefectStateType": str(state_type or "") or None,
        "prefectFlowRunId": flow_run_id,
        "prefectDeploymentId": _serialize_uuidish(_value(flow_run, "deployment_id")),
        "prefectWorkPoolName": _string_or_none(_value(flow_run, "work_pool_name")),
    }


def _ingest_flow_run_fields(flow_run: Any) -> JsonDict:
    parameters = _flow_run_parameters(flow_run)
    return {
        "kind": JobKind.INGEST.value,
        "payload": {
            "intakeId": _string_or_none(parameters.get("intake_id")),
            "originalFilename": _string_or_none(parameters.get("original_filename")),
            "audioHash": _string_or_none(parameters.get("audio_hash")),
            "operation": "remove" if parameters.get("audio_hash") else "ingest",
        },
        "result": None,
        "result_preview": None,
        "artifacts": [],
    }


def _correction_index_flow_run_fields(flow_run: Any) -> JsonDict:
    parameters = _flow_run_parameters(flow_run)
    return {
        "kind": JobKind.CORRECTION_INDEX.value,
        "payload": {
            "audioHash": _string_or_none(parameters.get("audio_hash")),
            "operation": _string_or_none(parameters.get("operation")),
            "operationToken": _string_or_none(parameters.get("operation_token")),
        },
        "result": None,
        "result_preview": None,
        "artifacts": [],
    }


def _flow_run_parameters(flow_run: Any) -> JsonDict:
    parameters = _value(flow_run, "parameters")
    return parameters if isinstance(parameters, dict) else {}


def normalize_flow_run_history(
    *,
    flow_run_id: str,
    states: Sequence[Any],
    prefect_ui_url: str | None = None,
) -> JsonDict:
    events = []
    for state in states:
        events.append(
            {
                "event_type": "state",
                "stateName": _string_or_none(_value(state, "name")),
                "stateType": _string_or_none(_value(state, "type")),
                "message": _string_or_none(_value(state, "message")),
                "created_at": serialize_datetime(
                    _value(state, "timestamp") or _value(state, "created")
                ),
            }
        )

    ui_url = None
    if prefect_ui_url:
        ui_url = f"{prefect_ui_url.rstrip('/')}/flow-runs/flow-run/{flow_run_id}"

    return {
        "events": events,
        "artifacts": [],
        "prefectUiUrl": ui_url,
    }


def _value(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    rendered = str(value).strip()
    return rendered or None


def _serialize_uuidish(value: Any) -> str | None:
    if isinstance(value, UUID):
        return str(value)
    return _string_or_none(value)


def _state_message(flow_run: Any) -> str | None:
    state = _value(flow_run, "state")
    if state is None:
        return None
    return _string_or_none(_value(state, "message"))
