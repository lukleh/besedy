"""HTTP client for Besedy's internal deep-search endpoints."""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

JsonDict = dict[str, Any]


class DeepSearchClientError(RuntimeError):
    """Raised when the Besedy internal deep-search API fails."""

    def __init__(self, message: str, *, status_code: int, payload: JsonDict | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class DeepSearchClient(Protocol):
    def search_catalog(
        self,
        *,
        catalog_id: str,
        query: str,
        top_k: int,
        include_neighbors: bool = True,
        neighbor_count: int = 1,
    ) -> JsonDict: ...

    def get_chunk_window(
        self,
        *,
        catalog_id: str,
        chunk_id: str,
        neighbor_count: int,
    ) -> JsonDict: ...

    def get_metadata(
        self,
        *,
        catalog_id: str,
        audio_hash: str,
    ) -> JsonDict: ...


@dataclass(slots=True)
class BesedyDeepSearchClientConfig:
    base_url: str
    bearer_token: str
    timeout_seconds: float = 15.0


class BesedyDeepSearchClient:
    """Small JSON client for the internal Besedy deep-search API surface."""

    def __init__(self, config: BesedyDeepSearchClientConfig) -> None:
        base_url = config.base_url.strip()
        if not base_url:
            raise ValueError("base_url must not be empty.")
        if not config.bearer_token.strip():
            raise ValueError("bearer_token must not be empty.")

        self._base_url = base_url.rstrip("/")
        self._bearer_token = config.bearer_token.strip()
        self._timeout_seconds = max(1.0, config.timeout_seconds)

    def search_catalog(
        self,
        *,
        catalog_id: str,
        query: str,
        top_k: int,
        include_neighbors: bool = True,
        neighbor_count: int = 1,
    ) -> JsonDict:
        return self._post_json(
            "/api/internal/deep-search/search",
            {
                "catalogId": catalog_id,
                "query": query,
                "limit": top_k,
                "includeNeighbors": include_neighbors,
                "neighborCount": neighbor_count if include_neighbors else 0,
            },
        )

    def get_chunk_window(
        self,
        *,
        catalog_id: str,
        chunk_id: str,
        neighbor_count: int,
    ) -> JsonDict:
        return self._post_json(
            "/api/internal/deep-search/citation",
            {
                "catalogId": catalog_id,
                "chunkId": chunk_id,
                "neighborCount": neighbor_count,
            },
        )

    def get_metadata(
        self,
        *,
        catalog_id: str,
        audio_hash: str,
    ) -> JsonDict:
        return self._post_json(
            "/api/internal/deep-search/metadata",
            {
                "catalogId": catalog_id,
                "audioHash": audio_hash,
            },
        )

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
                    raise DeepSearchClientError(
                        "Internal deep-search response must be a JSON object.",
                        status_code=response.status,
                    )
                return parsed
        except urllib_error.HTTPError as exc:
            raw_body = exc.read().decode("utf-8")
            payload_body = _parse_error_payload(raw_body)
            message = (
                _extract_error_message(payload_body) or exc.reason or "Internal request failed."
            )
            raise DeepSearchClientError(
                message,
                status_code=exc.code,
                payload=payload_body,
            ) from exc
        except urllib_error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise DeepSearchClientError(
                    "Internal deep-search request timed out.",
                    status_code=504,
                ) from exc
            raise DeepSearchClientError(
                "Internal deep-search request failed.",
                status_code=502,
            ) from exc


def build_besedy_deep_search_client_from_env() -> DeepSearchClient | None:
    base_url = os.getenv("BESEDY_INTERNAL_BASE_URL", "").strip()
    bearer_token = os.getenv("BESEDY_JOB_SERVICE_SECRET", "").strip()
    if not base_url or not bearer_token:
        return None

    timeout_ms = int(os.getenv("BESEDY_INTERNAL_TIMEOUT_MS", "15000"))
    return BesedyDeepSearchClient(
        BesedyDeepSearchClientConfig(
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
    return error_value if isinstance(error_value, str) and error_value.strip() else None
