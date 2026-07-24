from __future__ import annotations

import json
import threading
from collections.abc import Generator
from http import HTTPStatus
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from besedy.lib.http_server import JsonApiHandler


def _request(
    method: str,
    url: str,
    *,
    body: bytes | None = None,
    content_type: str | None = None,
) -> tuple[int, dict[str, object]]:
    headers: dict[str, str] = {}
    if content_type is not None:
        headers["Content-Type"] = content_type
    request = Request(url, data=body, method=method, headers=headers)
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        payload = json.loads(exc.read().decode("utf-8"))
        return exc.code, payload


class _EchoHandler(JsonApiHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._write_json(HTTPStatus.OK, {"ready": True})
            return

        if self.path == "/missing":
            self._dispatch_json(lambda: (_ for _ in ()).throw(FileNotFoundError("missing")))
            return

        if self.path == "/invalid":
            self._dispatch_json(lambda: (_ for _ in ()).throw(ValueError("bad_request")))
            return

        if self.path == "/crash":
            self._dispatch_json(lambda: (_ for _ in ()).throw(RuntimeError("boom")))
            return

        self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/echo":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self._dispatch_json(lambda: {"received": self._read_json_payload()})


@pytest.fixture()
def echo_server() -> Generator[tuple[ThreadingHTTPServer, str]]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EchoHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        yield server, base_url
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_json_api_handler_reads_and_writes_json(echo_server: tuple[ThreadingHTTPServer, str]) -> None:
    _server, base_url = echo_server

    status, payload = _request(
        "POST",
        f"{base_url}/echo",
        body=json.dumps({"query": "rozpocet"}).encode("utf-8"),
        content_type="application/json",
    )

    assert status == 200
    assert payload == {"received": {"query": "rozpocet"}}


def test_json_api_handler_rejects_non_object_json(
    echo_server: tuple[ThreadingHTTPServer, str],
) -> None:
    _server, base_url = echo_server

    status, payload = _request(
        "POST",
        f"{base_url}/echo",
        body=b"[]",
        content_type="application/json",
    )

    assert status == 400
    assert payload == {"error": "Request body must be a JSON object."}


@pytest.mark.parametrize(
    ("path", "expected_status", "expected_payload"),
    [
        ("/health", 200, {"ready": True}),
        ("/missing", 404, {"error": "missing"}),
        ("/invalid", 400, {"error": "bad_request"}),
        ("/crash", 500, {"error": "boom"}),
        ("/unknown", 404, {"error": "not_found"}),
    ],
)
def test_json_api_handler_maps_standard_errors(
    echo_server: tuple[ThreadingHTTPServer, str],
    path: str,
    expected_status: int,
    expected_payload: dict[str, object],
) -> None:
    _server, base_url = echo_server

    status, payload = _request("GET", f"{base_url}{path}")

    assert status == expected_status
    assert payload == expected_payload
