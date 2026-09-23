"""Typed models and normalization helpers for Prefect-backed jobs."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any
from uuid import UUID

from besedy.config.settings import get_config

from .json_types import JsonDict, coerce_json_dict
from .rlm_logs import load_rlm_progress

_SANITIZE_TAG_RE = re.compile(r"[^a-z0-9._:-]+")
DEFAULT_DEEP_SEARCH_TOP_K = 200
DEFAULT_DEEP_SEARCH_INCLUDE_NEIGHBORS = True
DEFAULT_DEEP_SEARCH_NEIGHBOR_COUNT = 1
DEFAULT_DEEP_SEARCH_WINDOW_NEIGHBOR_COUNT = 1


class DeepSearchConfigurationError(RuntimeError):
    """Raised when required Deep Search runtime configuration is missing."""


def get_deep_search_default_instructions() -> str:
    text = _required_config_string(
        get_config().web.deep_search_default_instructions,
        "web.deep_search_default_instructions",
    )
    if len(text) > 4000:
        raise DeepSearchConfigurationError(
            "web.deep_search_default_instructions must be 4000 characters or fewer."
        )
    return text


def _required_config_string(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise DeepSearchConfigurationError(f"{name} is required in besedy.toml.")
    text = value.strip()
    if not text:
        raise DeepSearchConfigurationError(f"{name} must not be empty in besedy.toml.")
    return text


def pick_json_value(value: object, *keys: str) -> object | None:
    payload = coerce_json_dict(value)
    for key in keys:
        candidate = payload.get(key)
        if candidate is not None:
            return candidate
    return None


class JobKind(StrEnum):
    DEEP_SEARCH = "DEEP_SEARCH"
    INGEST = "INGEST"
    CORRECTION_INDEX = "CORRECTION_INDEX"


JOB_KIND_TAGS: dict[JobKind, str] = {
    JobKind.DEEP_SEARCH: "job-kind:deep-search",
    JobKind.INGEST: "job-kind:ingest",
    JobKind.CORRECTION_INDEX: "job-kind:correction-index",
}


def job_kind_tag(kind: JobKind) -> str:
    return JOB_KIND_TAGS[kind]


def job_kind_from_tags(tags: object) -> JobKind:
    """Resolve the job kind from flow-run tags; untagged runs are deep-search."""
    if isinstance(tags, list | tuple | set):
        rendered = {str(tag) for tag in tags}
        for kind, tag in JOB_KIND_TAGS.items():
            if tag in rendered:
                return kind
    return JobKind.DEEP_SEARCH


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


@dataclass(slots=True, frozen=True)
class DeepSearchSubmitRequest:
    query: str
    instructions: str
    requested_by_id: str
    top_k: int = DEFAULT_DEEP_SEARCH_TOP_K
    lm_profile: str | None = None
    sub_lm_profile: str | None = None
    caller_scope: str | None = None

    @classmethod
    def from_payload(cls, payload: JsonDict) -> DeepSearchSubmitRequest:
        if "form" in payload:
            raise ValueError("form has been removed. Use instructions.")

        query = str(payload.get("query", "")).strip()
        if not query:
            raise ValueError("query must not be empty.")

        instructions = payload.get("instructions")
        if instructions is None:
            instructions = get_deep_search_default_instructions()
        if not isinstance(instructions, str):
            raise ValueError("instructions must be a string when provided.")
        instructions_text = instructions.strip()
        if not instructions_text:
            raise ValueError("instructions must not be empty.")

        top_k = int(payload.get("topK", DEFAULT_DEEP_SEARCH_TOP_K))
        if top_k <= 0:
            raise ValueError("topK must be positive.")

        if "bundleKey" in payload or "bundle_key" in payload:
            raise ValueError("bundleKey has been removed. Use lmProfile and subLmProfile instead.")

        lm_profile = payload.get("lmProfile")
        if lm_profile is not None and (not isinstance(lm_profile, str) or not lm_profile.strip()):
            raise ValueError("lmProfile must be a non-empty string when provided.")

        sub_lm_profile = payload.get("subLmProfile")
        if sub_lm_profile is not None and (
            not isinstance(sub_lm_profile, str) or not sub_lm_profile.strip()
        ):
            raise ValueError("subLmProfile must be a non-empty string when provided.")

        requested_by_id = payload.get("requestedById")
        if not isinstance(requested_by_id, str) or not requested_by_id.strip():
            raise ValueError("requestedById is required and must be a non-empty string.")

        caller_scope = payload.get("callerScope")
        if caller_scope is not None and (
            not isinstance(caller_scope, str) or not caller_scope.strip()
        ):
            raise ValueError("callerScope must be a non-empty string when provided.")

        return cls(
            query=query,
            instructions=instructions_text,
            top_k=top_k,
            lm_profile=lm_profile.strip() if isinstance(lm_profile, str) else None,
            sub_lm_profile=sub_lm_profile.strip() if isinstance(sub_lm_profile, str) else None,
            requested_by_id=requested_by_id.strip(),
            caller_scope=caller_scope.strip() if isinstance(caller_scope, str) else None,
        )

    def to_flow_parameters(self, *, catalog_id: str) -> JsonDict:
        requested_by_id = self.requested_by_id
        caller_scope = self.caller_scope or requested_by_id
        parameters: JsonDict = {
            "catalog_id": catalog_id,
            "query": self.query,
            "requested_by_id": requested_by_id,
            "caller_scope": caller_scope,
            "retrieval": {
                "top_k": self.top_k,
                "include_neighbors": DEFAULT_DEEP_SEARCH_INCLUDE_NEIGHBORS,
                "neighbor_count": DEFAULT_DEEP_SEARCH_NEIGHBOR_COUNT,
                "window": {
                    "neighbor_count": DEFAULT_DEEP_SEARCH_WINDOW_NEIGHBOR_COUNT,
                },
                "lm_profile": self.lm_profile,
                "sub_lm_profile": self.sub_lm_profile,
            },
            "execution": {},
        }
        parameters["instructions"] = self.instructions
        return parameters


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
            "catalog_id": validate_catalog_id(catalog_id),
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
            "catalog_id": validate_catalog_id(catalog_id),
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

    @classmethod
    def from_payload(cls, payload: JsonDict) -> CorrectionIndexSyncRequest:
        requested_by_id = payload.get("requestedById")
        attempt_raw = payload.get("attempt", 0)
        if not isinstance(attempt_raw, int) or isinstance(attempt_raw, bool) or attempt_raw < 0:
            raise ValueError("attempt must be a non-negative integer.")
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
        )

    def to_flow_parameters(self, *, catalog_id: str) -> JsonDict:
        return {
            "catalog_id": validate_catalog_id(catalog_id),
            "audio_hash": self.audio_hash,
            "operation": self.operation,
            "operation_token": self.operation_token,
            "requested_by_id": self.requested_by_id,
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


def build_flow_run_name(*, catalog_id: str, query: str) -> str:
    stamp = utcnow().strftime("%Y%m%d-%H%M%S")
    catalog = sanitize_tag_value(catalog_id, fallback="catalog")
    query_part = sanitize_tag_value(query[:24], fallback="query")
    return f"deep-search-{catalog}-{query_part}-{stamp}"


def build_flow_run_tags(
    *,
    catalog_id: str,
    requested_by_id: str | None,
    caller_scope: str | None,
) -> list[str]:
    tags = [
        "job-kind:deep-search",
        f"catalog:{sanitize_tag_value(catalog_id, fallback='catalog')}",
    ]
    if requested_by_id:
        tags.append(f"requested-by:{sanitize_tag_value(requested_by_id)}")
    if caller_scope:
        tags.append(f"caller-scope:{sanitize_tag_value(caller_scope)}")
    return tags


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


def flow_run_output_dir(*, root_dir: Path, flow_run_id: str) -> Path:
    return root_dir / flow_run_id


def load_output_bundle(*, root_dir: Path, flow_run_id: str) -> JsonDict:
    bundle_dir = flow_run_output_dir(root_dir=root_dir, flow_run_id=flow_run_id)
    if not bundle_dir.exists():
        return {
            "bundleDir": str(bundle_dir),
            "artifacts": [],
            "result": None,
            "rlmProgress": None,
        }

    result = _load_json_if_exists(bundle_dir / "result.json")
    rlm_progress = load_rlm_progress(root_dir=root_dir, flow_run_id=flow_run_id)
    artifacts = []
    for path in sorted(bundle_dir.iterdir()):
        if path.is_file():
            artifacts.append({"name": path.name, "path": str(path)})

    return {
        "bundleDir": str(bundle_dir),
        "artifacts": artifacts,
        "result": result if isinstance(result, dict) else None,
        "rlmProgress": rlm_progress,
        "reportMarkdownPath": str(bundle_dir / "report.md")
        if (bundle_dir / "report.md").exists()
        else None,
        "initialHitsPath": str(bundle_dir / "initial_hits.json")
        if (bundle_dir / "initial_hits.json").exists()
        else None,
        "followupTracePath": str(bundle_dir / "followup_trace.json")
        if (bundle_dir / "followup_trace.json").exists()
        else None,
        "runMetadataPath": str(bundle_dir / "run_metadata.json")
        if (bundle_dir / "run_metadata.json").exists()
        else None,
    }


def normalize_flow_run(
    flow_run: Any,
    *,
    output_root_dir: Path,
) -> JsonDict:
    envelope = _flow_run_envelope(flow_run)
    kind = job_kind_from_tags(_value(flow_run, "tags"))
    if kind == JobKind.INGEST:
        return {**envelope, **_ingest_flow_run_fields(flow_run)}
    if kind == JobKind.CORRECTION_INDEX:
        return {**envelope, **_correction_index_flow_run_fields(flow_run)}
    return {
        **envelope,
        **_deep_search_flow_run_fields(flow_run, output_root_dir=output_root_dir),
    }


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


def _deep_search_flow_run_fields(flow_run: Any, *, output_root_dir: Path) -> JsonDict:
    flow_run_id = str(_value(flow_run, "id"))
    parameters = _flow_run_parameters(flow_run)
    output_bundle = load_output_bundle(root_dir=output_root_dir, flow_run_id=flow_run_id)
    result = output_bundle.get("result")
    result_preview = None
    if isinstance(result, dict):
        markdown = result.get("markdown")
        if isinstance(markdown, str) and markdown.strip():
            first_line = markdown.strip().splitlines()[0].strip()
            result_preview = first_line[:200] if first_line else None
    return {
        "kind": JobKind.DEEP_SEARCH.value,
        "payload": {
            "query": _string_or_none(parameters.get("query")),
            "instructions": _string_or_none(parameters.get("instructions")),
            "retrieval": _as_object(parameters.get("retrieval")),
            "execution": _as_object(parameters.get("execution")),
        },
        "result": result if isinstance(result, dict) else None,
        "result_preview": result_preview,
        "rlmProgress": output_bundle.get("rlmProgress"),
        "artifacts": output_bundle.get("artifacts", []),
        "outputBundle": {
            "bundleDir": output_bundle.get("bundleDir"),
            "reportMarkdownPath": output_bundle.get("reportMarkdownPath"),
            "initialHitsPath": output_bundle.get("initialHitsPath"),
            "followupTracePath": output_bundle.get("followupTracePath"),
            "runMetadataPath": output_bundle.get("runMetadataPath"),
        },
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
    output_root_dir: Path,
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

    output_bundle = load_output_bundle(root_dir=output_root_dir, flow_run_id=flow_run_id)
    ui_url = None
    if prefect_ui_url:
        ui_url = f"{prefect_ui_url.rstrip('/')}/flow-runs/flow-run/{flow_run_id}"

    return {
        "events": events,
        "artifacts": output_bundle.get("artifacts", []),
        "prefectUiUrl": ui_url,
    }


def _load_json_if_exists(path: Path) -> Any:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _as_object(value: Any) -> JsonDict:
    return coerce_json_dict(value)


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
