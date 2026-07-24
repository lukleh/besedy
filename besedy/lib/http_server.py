"""Small helpers for JSON-over-HTTP services."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class JsonApiHandler(BaseHTTPRequestHandler):
    """Base handler with shared JSON I/O and error mapping."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A003
        return

    def _read_json_payload(self) -> dict[str, Any]:
        length_header = self.headers.get("Content-Length")
        if length_header is None:
            return {}
        content_length = int(length_header)
        raw_body = self.rfile.read(content_length).decode("utf-8")
        if not raw_body.strip():
            return {}
        payload = json.loads(raw_body)
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        return payload

    def _write_json(self, status: HTTPStatus, payload: Mapping[str, Any]) -> None:
        body = json.dumps(dict(payload), ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _dispatch_json(self, operation: Callable[[], Mapping[str, Any]]) -> None:
        try:
            result = operation()
        except ValueError as exc:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except FileNotFoundError as exc:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": str(exc)})
            return
        except Exception as exc:  # pragma: no cover - runtime boundary
            self._write_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return
        self._write_json(HTTPStatus.OK, result)


def serve_threading_http_server(
    *,
    host: str,
    port: int,
    handler: type[BaseHTTPRequestHandler],
) -> None:
    """Run a ThreadingHTTPServer until interrupted."""

    server = ThreadingHTTPServer((host, port), handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover - manual runtime exit
        pass
    finally:
        server.server_close()
