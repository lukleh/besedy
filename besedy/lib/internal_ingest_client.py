"""HTTP client for Besedy's internal recording-ingest completion endpoint."""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from enum import StrEnum
from typing import Any
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

JsonDict = dict[str, Any]


class IngestCompletionStatus(StrEnum):
    SUCCEEDED = "SUCCEEDED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    REMOVED = "REMOVED"


class IngestClientError(RuntimeError):
    """Raised when the Besedy internal ingest API fails."""

    def __init__(self, message: str, *, status_code: int, payload: JsonDict | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload

    @property
    def retryable(self) -> bool:
        return self.status_code >= 500 or self.status_code in {408, 425, 429}


@dataclass(slots=True, frozen=True)
class IngestCompletionReport:
    status: IngestCompletionStatus
    audio_hash: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    def to_payload(self) -> JsonDict:
        return {
            "status": self.status.value,
            "audioHash": self.audio_hash,
            "errorCode": self.error_code,
            "errorMessage": self.error_message,
        }


@dataclass(slots=True)
class BesedyIngestClientConfig:
    base_url: str
    bearer_token: str
    timeout_seconds: float = 30.0


class BesedyIngestClient:
    """Small JSON client for the internal ingest completion route."""

    def __init__(self, config: BesedyIngestClientConfig) -> None:
        base_url = config.base_url.strip()
        if not base_url:
            raise ValueError("base_url must not be empty.")
        if not config.bearer_token.strip():
            raise ValueError("bearer_token must not be empty.")
        self._base_url = base_url.rstrip("/")
        self._bearer_token = config.bearer_token.strip()
        self._timeout_seconds = max(1.0, config.timeout_seconds)

    def report_completion(self, *, intake_id: str, report: IngestCompletionReport) -> JsonDict:
        path = f"/api/internal/ingest/{urllib_parse.quote(intake_id, safe='')}/complete"
        return self._post_json(path, report.to_payload())

    def _post_json(self, path: str, payload: JsonDict) -> JsonDict:
        url = urllib_parse.urljoin(f"{self._base_url}/", path.lstrip("/"))
        request = urllib_request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._bearer_token}",
            },
            method="POST",
        )
        try:
            with urllib_request.urlopen(request, timeout=self._timeout_seconds) as response:
                raw_body = response.read().decode("utf-8")
                parsed = json.loads(raw_body) if raw_body else {}
                if not isinstance(parsed, dict):
                    raise IngestClientError(
                        "Internal ingest response must be a JSON object.",
                        status_code=response.status,
                    )
                return parsed
        except urllib_error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8")
            payload_body = _parse_error_payload(raw_body)
            message = (
                _extract_error_message(payload_body) or exc.reason or "Internal request failed."
            )
            raise IngestClientError(message, status_code=exc.code, payload=payload_body) from exc
        except urllib_error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, TimeoutError | socket.timeout):
                raise IngestClientError(
                    "Internal ingest request timed out.", status_code=504
                ) from exc
            raise IngestClientError("Internal ingest request failed.", status_code=502) from exc


def build_besedy_ingest_client_from_env() -> BesedyIngestClient:
    base_url = os.getenv("BESEDY_INTERNAL_BASE_URL", "").strip()
    bearer_token = os.getenv("BESEDY_JOB_SERVICE_SECRET", "").strip()
    if not base_url or not bearer_token:
        raise RuntimeError(
            "BESEDY_INTERNAL_BASE_URL and BESEDY_JOB_SERVICE_SECRET are required "
            "for the ingest worker to report completion to the web app."
        )
    timeout_ms = int(os.getenv("BESEDY_INTERNAL_TIMEOUT_MS", "30000"))
    return BesedyIngestClient(
        BesedyIngestClientConfig(
            base_url=base_url,
            bearer_token=bearer_token,
            timeout_seconds=max(1.0, timeout_ms / 1000.0),
        )
    )


def _parse_error_payload(raw_body: str) -> JsonDict | None:
    if not raw_body.strip():
        return None
    try:
        parsed = json.loads(raw_body)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _extract_error_message(payload: JsonDict | None) -> str | None:
    if payload is None:
        return None
    error_value = payload.get("error")
    if isinstance(error_value, str) and error_value.strip():
        return error_value.strip()
    return None
