from __future__ import annotations

import csv
import json
import sys
import threading
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

pytestmark = pytest.mark.optional_dependency
pytest.importorskip("prefect", reason="requires the optional jobs extra")

from besedy.lib import internal_ingest_client as ingest_client_module  # noqa: E402
from besedy.lib.internal_ingest_client import (  # noqa: E402
    BesedyIngestClient,
    BesedyIngestClientConfig,
    IngestClientError,
    IngestCompletionReport,
    IngestCompletionStatus,
)
from besedy.lib.prefect_jobs.api import PrefectJobsApiService  # noqa: E402
from besedy.lib.prefect_jobs.flows import ingest_recording as ingest_module  # noqa: E402
from besedy.lib.prefect_jobs.models import (  # noqa: E402
    IngestSubmitRequest,
    JobKind,
    JobStatus,
    build_ingest_flow_run_tags,
    job_kind_from_tags,
    normalize_flow_run,
)

CATALOG_ID = "20260201_120000"
INTAKE_ID = "cmf9abcdefghijklmnopqrstu"
KNOWN_HASH = "a" * 64
NEW_HASH = "b" * 64


class FakePrefectClient:
    def __init__(self) -> None:
        now = datetime.now(UTC)
        self.flow_run_id = str(uuid4())
        self.submit_calls: list[dict[str, object]] = []
        self.read_flow_runs_calls: list[dict[str, object]] = []
        self.flow_run = SimpleNamespace(
            id=self.flow_run_id,
            created=now,
            updated=now,
            start_time=None,
            end_time=None,
            state_name="Scheduled",
            state_type="SCHEDULED",
            deployment_id=str(uuid4()),
            work_pool_name="besedy-ingest",
            parameters={},
            state=SimpleNamespace(message=None),
            tags=[],
        )

    def create_deployment_run(self, **kwargs: object) -> object:
        self.submit_calls.append(kwargs)
        self.flow_run.parameters = kwargs["parameters"]
        self.flow_run.tags = kwargs["tags"]
        return self.flow_run

    def read_flow_run(self, *, flow_run_id: str) -> object:
        return self.flow_run

    def read_flow_runs(self, *, tags, limit, state_names=None):  # type: ignore[no-untyped-def]
        self.read_flow_runs_calls.append({"tags": tags, "limit": limit, "state_names": state_names})
        run_tags = list(self.flow_run.tags)
        return [self.flow_run] if all(tag in run_tags for tag in tags) else []

    def read_flow_run_states(self, *, flow_run_id: str):  # type: ignore[no-untyped-def]
        return []

    def cancel_flow_run(self, *, flow_run_id: str) -> object:
        return SimpleNamespace(status="ACCEPT")


def _write_catalog(path: Path, hashes: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Hash", "Hash Algorithm", "Full Path", "Scan Root", "added_at"])
        for value in hashes:
            writer.writerow(
                [
                    value,
                    "pcm-s16le-16000hz-mono-sha256-v1",
                    f"/media/{value[:8]}.mp3",
                    "/media",
                    "2026-01-01T00:00:00Z",
                ]
            )


def _layout(tmp_path: Path, *, hashes: list[str]) -> ingest_module.IngestPaths:
    uploads = tmp_path / "uploads"
    catalogs = tmp_path / "text" / "catalogs"
    _write_catalog(catalogs / f"audio_catalog_{CATALOG_ID}.csv", hashes)
    paths = ingest_module.resolve_ingest_paths(
        CATALOG_ID, INTAKE_ID, uploads_root=uploads, catalogs_root=catalogs
    )
    paths.incoming_dir.mkdir(parents=True)
    (paths.incoming_dir / "source.mp3").write_bytes(b"not really audio")
    return paths


# --- models -----------------------------------------------------------------


def test_ingest_submit_request_validates_tokens() -> None:
    request = IngestSubmitRequest.from_payload(
        {"intakeId": INTAKE_ID, "originalFilename": "talk.mp3", "requestedById": "admin-1"}
    )
    assert request.to_flow_parameters(catalog_id=CATALOG_ID) == {
        "catalog_id": CATALOG_ID,
        "intake_id": INTAKE_ID,
        "original_filename": "talk.mp3",
        "requested_by_id": "admin-1",
    }

    with pytest.raises(ValueError, match="intakeId"):
        IngestSubmitRequest.from_payload({"intakeId": "../etc", "originalFilename": "a.mp3"})
    with pytest.raises(ValueError, match="path separators"):
        IngestSubmitRequest.from_payload({"intakeId": INTAKE_ID, "originalFilename": "../a.mp3"})
    with pytest.raises(ValueError, match="catalog_id"):
        IngestSubmitRequest.from_payload(
            {"intakeId": INTAKE_ID, "originalFilename": "a.mp3"}
        ).to_flow_parameters(catalog_id="../../etc")


def test_job_kind_is_derived_from_tags() -> None:
    assert job_kind_from_tags(["job-kind:ingest", "catalog:x"]) == JobKind.INGEST
    assert job_kind_from_tags(["job-kind:deep-search"]) == JobKind.DEEP_SEARCH
    assert job_kind_from_tags(None) == JobKind.DEEP_SEARCH
    assert build_ingest_flow_run_tags(
        catalog_id=CATALOG_ID, intake_id=INTAKE_ID, requested_by_id="Admin 1"
    ) == [
        "job-kind:ingest",
        f"catalog:{CATALOG_ID}",
        f"intake:{INTAKE_ID}",
        "operation:ingest",
        "requested-by:admin-1",
    ]


def test_normalize_ingest_flow_run_exposes_intake_payload(tmp_path: Path) -> None:
    now = datetime.now(UTC)
    flow_run = SimpleNamespace(
        id="run-1",
        created=now,
        updated=now,
        start_time=now,
        end_time=None,
        state_name="Running",
        state_type="RUNNING",
        deployment_id=None,
        work_pool_name="besedy-ingest",
        parameters={
            "catalog_id": CATALOG_ID,
            "intake_id": INTAKE_ID,
            "original_filename": "talk.mp3",
            "requested_by_id": "admin-1",
        },
        state=SimpleNamespace(message=None),
        tags=["job-kind:ingest"],
    )
    job = normalize_flow_run(flow_run, output_root_dir=tmp_path)
    assert job["kind"] == "INGEST"
    assert job["status"] == JobStatus.RUNNING.value
    assert job["payload"] == {
        "intakeId": INTAKE_ID,
        "originalFilename": "talk.mp3",
        "audioHash": None,
        "operation": "ingest",
    }
    assert job["catalog_id"] == CATALOG_ID
    assert "outputBundle" not in job


# --- API facade -------------------------------------------------------------


def test_service_submits_and_lists_ingest_jobs(tmp_path: Path) -> None:
    fake_client = FakePrefectClient()
    service = PrefectJobsApiService(
        client=fake_client,
        output_root_dir=tmp_path,
        ingest_deployment_name="ingest_recording_flow/ingest-test",
    )

    created = service.submit_ingest(
        catalog_id=CATALOG_ID,
        payload={"intakeId": INTAKE_ID, "originalFilename": "talk.mp3", "requestedById": "a1"},
    )
    assert created["kind"] == "INGEST"
    assert created["payload"]["intakeId"] == INTAKE_ID
    submit = fake_client.submit_calls[0]
    assert submit["deployment_name"] == "ingest_recording_flow/ingest-test"
    assert submit["idempotency_key"] == f"ingest:{INTAKE_ID}"
    assert submit["parameters"]["catalog_id"] == CATALOG_ID

    listed = service.list_jobs(raw_query=f"kind=INGEST&catalogId={CATALOG_ID}")
    assert [job["id"] for job in listed["jobs"]] == [fake_client.flow_run_id]
    assert fake_client.read_flow_runs_calls[-1]["tags"][0] == "job-kind:ingest"

    assert service.list_jobs(raw_query="kind=DEEP_SEARCH")["jobs"] == []

    with pytest.raises(ValueError):
        service.submit_ingest(
            catalog_id="not-a-catalog", payload={"intakeId": INTAKE_ID, "originalFilename": "a.mp3"}
        )


# --- flow helpers -----------------------------------------------------------


def test_resolve_ingest_paths_derives_everything_from_ids(tmp_path: Path) -> None:
    paths = ingest_module.resolve_ingest_paths(
        CATALOG_ID, INTAKE_ID, uploads_root=tmp_path / "up", catalogs_root=tmp_path / "cat"
    )
    assert paths.incoming_dir == tmp_path / "up" / CATALOG_ID / "incoming" / INTAKE_ID
    assert paths.accepted_dir == tmp_path / "up" / CATALOG_ID / "accepted" / INTAKE_ID
    assert paths.rejected_dir == tmp_path / "up" / CATALOG_ID / "rejected" / INTAKE_ID
    assert paths.catalog_csv == tmp_path / "cat" / f"audio_catalog_{CATALOG_ID}.csv"
    with pytest.raises(ValueError):
        ingest_module.resolve_ingest_paths(
            "../x", INTAKE_ID, uploads_root=tmp_path, catalogs_root=tmp_path
        )


def test_find_intake_source_requires_exactly_one_file(tmp_path: Path) -> None:
    with pytest.raises(ingest_module.IngestFlowError) as missing:
        ingest_module.find_intake_source(tmp_path / "nope")
    assert missing.value.error_code == "intake_missing"

    (tmp_path / "source.mp3").write_bytes(b"x")
    (tmp_path / "source.mp3.audiohash").write_text("ignored")
    assert ingest_module.find_intake_source(tmp_path) == tmp_path / "source.mp3"

    (tmp_path / "second.mp3").write_bytes(b"y")
    with pytest.raises(ingest_module.IngestFlowError) as too_many:
        ingest_module.find_intake_source(tmp_path)
    assert too_many.value.error_code == "intake_invalid"


def test_accepted_filename_sanitizes_user_input() -> None:
    name = ingest_module.accepted_filename("Beseda: říjen/2026 ?.MP3", Path("source.mp3"))
    assert name.endswith(".mp3")
    assert "/" not in name and ":" not in name and "?" not in name
    assert ingest_module.accepted_filename("x", Path("source.weird-ext!")) == "x"
    assert ingest_module.accepted_filename("???", Path("source.mp3")) == "recording.mp3"


def test_run_catalog_cli_streams_output_and_raises_on_failure(tmp_path: Path) -> None:
    lines: list[str] = []
    ok_args = ["-c", "print('hello'); print('world')"]

    # Swap the module entry for a plain interpreter script so the test does not need the CLI.
    original = ingest_module.catalog_cli_command
    ingest_module.catalog_cli_command = lambda args: [sys.executable, *args]  # type: ignore[assignment]
    try:
        ingest_module.run_catalog_cli(ok_args, stage="demo", cwd=tmp_path, log=lines.append)
        assert any("hello" in line for line in lines)

        with pytest.raises(ingest_module.IngestFlowError) as failure:
            ingest_module.run_catalog_cli(
                ["-c", "import sys; print('boom detail'); sys.exit(3)"],
                stage="run_pipeline",
                cwd=tmp_path,
                log=lines.append,
            )
        assert failure.value.error_code == "run_pipeline_failed"
        assert "boom detail" in str(failure.value)
        assert "code 3" in str(failure.value)
    finally:
        ingest_module.catalog_cli_command = original  # type: ignore[assignment]


def test_catalog_cli_command_uses_module_entrypoint() -> None:
    assert ingest_module.catalog_cli_command(["add", "x"]) == [
        sys.executable,
        "-m",
        "besedy.cli.catalog",
        "add",
        "x",
    ]


# --- flow ---------------------------------------------------------------------


def _run_flow(monkeypatch, paths: ingest_module.IngestPaths, *, audio_hash: str):  # type: ignore[no-untyped-def]
    cli_calls: list[list[str]] = []
    reports: list[tuple[str, dict[str, object]]] = []

    monkeypatch.setattr(ingest_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(ingest_module, "audio_content_sha256sum", lambda _path: audio_hash)
    monkeypatch.setattr(
        ingest_module,
        "run_catalog_cli",
        lambda args, *, stage, **_k: cli_calls.append([stage, *args]),
    )
    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_completion=lambda *, intake_id, report: (
                reports.append((intake_id, report.to_payload())) or {"ok": True}
            )
        ),
    )
    result = ingest_module.ingest_recording_flow(
        catalog_id=CATALOG_ID,
        intake_id=INTAKE_ID,
        original_filename="Talk 2026.mp3",
        requested_by_id="admin-1",
    )
    return result, cli_calls, reports


def test_flow_rejects_duplicate_without_running_pipeline(monkeypatch, tmp_path: Path) -> None:
    paths = _layout(tmp_path, hashes=[KNOWN_HASH])

    result, cli_calls, reports = _run_flow(monkeypatch, paths, audio_hash=KNOWN_HASH)

    assert result["status"] == "REJECTED"
    assert result["errorCode"] == "duplicate"
    assert result["audioHash"] == KNOWN_HASH
    assert cli_calls == []
    assert (paths.rejected_dir / "source.mp3").is_file()
    assert not paths.incoming_dir.exists()
    assert reports == [(INTAKE_ID, result)]


def test_flow_accepts_new_recording_and_runs_cli(monkeypatch, tmp_path: Path) -> None:
    paths = _layout(tmp_path, hashes=[KNOWN_HASH])

    result, cli_calls, reports = _run_flow(monkeypatch, paths, audio_hash=NEW_HASH)

    assert result["status"] == "SUCCEEDED"
    assert result["audioHash"] == NEW_HASH
    accepted = paths.accepted_dir / "Talk_2026.mp3"
    assert accepted.is_file()
    sidecar = Path(f"{accepted}.audiohash").read_text(encoding="utf-8")
    assert sidecar.startswith(f"{NEW_HASH}  {accepted.name}")
    assert not paths.incoming_dir.exists()
    assert cli_calls == [
        [
            "catalog_add",
            "add",
            str(paths.accepted_dir),
            "--csv",
            str(paths.catalog_csv),
            "--no-symlink",
        ],
        ["run_pipeline", "run-pipeline", "--csv", str(paths.catalog_csv), "--no-symlink"],
    ]
    assert reports == [(INTAKE_ID, result)]


def test_flow_reports_failure_before_reraising(monkeypatch, tmp_path: Path) -> None:
    paths = _layout(tmp_path, hashes=[])
    reports: list[dict[str, object]] = []

    monkeypatch.setattr(ingest_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(ingest_module, "audio_content_sha256sum", lambda _path: NEW_HASH)

    def failing_cli(args, *, stage, **_k):  # type: ignore[no-untyped-def]
        raise ingest_module.IngestFlowError("pipeline exploded", error_code=f"{stage}_failed")

    monkeypatch.setattr(ingest_module, "run_catalog_cli", failing_cli)
    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_completion=lambda *, intake_id, report: reports.append(report.to_payload())
        ),
    )

    with pytest.raises(ingest_module.IngestFlowError):
        ingest_module.ingest_recording_flow(
            catalog_id=CATALOG_ID,
            intake_id=INTAKE_ID,
            original_filename="talk.mp3",
        )

    assert reports == [
        {
            "status": "FAILED",
            "audioHash": None,
            "errorCode": "catalog_add_failed",
            "errorMessage": "pipeline exploded",
        }
    ]


def test_flow_fails_on_undecodable_audio(monkeypatch, tmp_path: Path) -> None:
    paths = _layout(tmp_path, hashes=[])
    reports: list[dict[str, object]] = []
    monkeypatch.setattr(ingest_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(ingest_module, "audio_content_sha256sum", lambda _path: None)
    monkeypatch.setattr(
        ingest_module, "run_catalog_cli", lambda *a, **k: pytest.fail("must not run")
    )
    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_completion=lambda *, intake_id, report: reports.append(report.to_payload())
        ),
    )

    with pytest.raises(ingest_module.IngestFlowError) as failure:
        ingest_module.ingest_recording_flow(
            catalog_id=CATALOG_ID, intake_id=INTAKE_ID, original_filename="talk.mp3"
        )
    assert failure.value.error_code == "undecodable_audio"
    assert reports[0]["errorCode"] == "undecodable_audio"
    assert (paths.incoming_dir / "source.mp3").is_file()


def test_flow_carries_outcome_when_final_report_cannot_be_delivered(
    monkeypatch, tmp_path: Path
) -> None:
    paths = _layout(tmp_path, hashes=[])
    monkeypatch.setattr(ingest_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(ingest_module, "audio_content_sha256sum", lambda _path: NEW_HASH)
    monkeypatch.setattr(ingest_module, "run_catalog_cli", lambda *a, **k: None)

    def unreachable(*, intake_id, report):  # type: ignore[no-untyped-def]
        raise IngestClientError("web down", status_code=502)

    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(report_completion=unreachable),
    )
    monkeypatch.setattr(
        ingest_module.report_completion, "retries", 0
    )  # keep the test fast; retry policy is Prefect's

    with pytest.raises(ingest_module.IngestFlowError) as failure:
        ingest_module.ingest_recording_flow(
            catalog_id=CATALOG_ID, intake_id=INTAKE_ID, original_filename="talk.mp3"
        )

    assert failure.value.error_code == "completion_report_failed"
    message = str(failure.value)
    marker = ingest_module.COMPLETION_REPORT_FAILED_MARKER
    assert marker in message
    outcome = json.loads(message[message.index(marker) + len(marker) :])
    assert outcome == {
        "status": "SUCCEEDED",
        "audioHash": NEW_HASH,
        "errorCode": None,
        "errorMessage": None,
    }
    # The recording itself was accepted; only the callback was lost.
    assert (paths.accepted_dir / "talk.mp3").is_file()


def test_service_maps_missing_prefect_run_to_not_found(tmp_path: Path) -> None:
    from prefect.exceptions import ObjectNotFound

    class MissingClient(FakePrefectClient):
        def read_flow_run(self, *, flow_run_id: str) -> object:
            raise ObjectNotFound(http_exc=RuntimeError("404"))

    service = PrefectJobsApiService(client=MissingClient(), output_root_dir=tmp_path)
    with pytest.raises(FileNotFoundError):
        service.get_job(job_id=str(uuid4()))


def test_removal_request_validates_hash_and_builds_parameters() -> None:
    from besedy.lib.prefect_jobs.models import IngestRemovalRequest

    request = IngestRemovalRequest.from_payload(
        {"intakeId": INTAKE_ID, "audioHash": NEW_HASH.upper(), "requestedById": "admin-1"}
    )
    assert request.to_flow_parameters(catalog_id=CATALOG_ID) == {
        "catalog_id": CATALOG_ID,
        "intake_id": INTAKE_ID,
        "audio_hash": NEW_HASH,
        "requested_by_id": "admin-1",
    }
    with pytest.raises(ValueError, match="audioHash"):
        IngestRemovalRequest.from_payload({"intakeId": INTAKE_ID, "audioHash": "../x"})


def test_service_submits_removal_on_the_ingest_pool(tmp_path: Path) -> None:
    fake_client = FakePrefectClient()
    service = PrefectJobsApiService(
        client=fake_client,
        output_root_dir=tmp_path,
        ingest_remove_deployment_name="remove_recording_flow/ingest-remove-test",
    )
    created = service.submit_ingest_removal(
        catalog_id=CATALOG_ID,
        payload={"intakeId": INTAKE_ID, "audioHash": NEW_HASH, "requestedById": "a1"},
    )
    submit = fake_client.submit_calls[0]
    assert submit["deployment_name"] == "remove_recording_flow/ingest-remove-test"
    assert "operation:remove" in submit["tags"]
    assert submit["flow_run_name"].startswith(f"ingest-remove-{CATALOG_ID}")
    assert created["kind"] == "INGEST"
    assert created["payload"] == {
        "intakeId": INTAKE_ID,
        "originalFilename": None,
        "audioHash": NEW_HASH,
        "operation": "remove",
    }


def _run_removal_flow(monkeypatch, paths, *, refresh_error: str | None = None):  # type: ignore[no-untyped-def]
    from besedy.lib.prefect_jobs.flows import remove_recording as remove_module

    cli_calls: list[list[str]] = []
    reports: list[dict[str, object]] = []

    def fake_cli(args, *, stage, **_k):  # type: ignore[no-untyped-def]
        cli_calls.append([stage, *args])
        if stage == "run_pipeline" and refresh_error:
            raise remove_module.IngestFlowError(refresh_error, error_code="run_pipeline_failed")

    monkeypatch.setattr(remove_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(remove_module, "run_catalog_cli", fake_cli)
    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_completion=lambda *, intake_id, report: (
                reports.append(report.to_payload()) or {"ok": True}
            )
        ),
    )
    result = remove_module.remove_recording_flow(
        catalog_id=CATALOG_ID, intake_id=INTAKE_ID, audio_hash=NEW_HASH.upper()
    )
    return result, cli_calls, reports


def test_removal_flow_runs_remove_then_pipeline_and_reports_removed(
    monkeypatch, tmp_path: Path
) -> None:
    paths = _layout(tmp_path, hashes=[NEW_HASH])
    paths.accepted_dir.mkdir(parents=True)
    (paths.accepted_dir / "talk.mp3").write_bytes(b"x")

    result, cli_calls, reports = _run_removal_flow(monkeypatch, paths)

    assert cli_calls == [
        [
            "catalog_remove",
            "remove",
            "--csv",
            str(paths.catalog_csv),
            "--hash",
            NEW_HASH,
            "--execute",
            "--delete-source",
            "--format",
            "json",
        ],
        ["run_pipeline", "run-pipeline", "--csv", str(paths.catalog_csv), "--no-symlink"],
    ]
    assert result == {
        "status": "REMOVED",
        "audioHash": NEW_HASH,
        "errorCode": None,
        "errorMessage": None,
    }
    assert reports == [result]
    assert not paths.accepted_dir.exists()
    assert not paths.incoming_dir.exists()


def test_removal_flow_reports_removed_with_warning_when_refresh_fails(
    monkeypatch, tmp_path: Path
) -> None:
    paths = _layout(tmp_path, hashes=[NEW_HASH])

    result, _cli_calls, reports = _run_removal_flow(
        monkeypatch, paths, refresh_error="run_pipeline exited with code 1"
    )

    assert result["status"] == "REMOVED"
    assert result["errorCode"] == "derived_refresh_failed"
    assert "code 1" in str(result["errorMessage"])
    assert reports == [result]


def test_removal_flow_reports_failure_when_remove_command_fails(
    monkeypatch, tmp_path: Path
) -> None:
    from besedy.lib.prefect_jobs.flows import remove_recording as remove_module

    paths = _layout(tmp_path, hashes=[NEW_HASH])
    reports: list[dict[str, object]] = []

    def failing_cli(args, *, stage, **_k):  # type: ignore[no-untyped-def]
        raise remove_module.IngestFlowError("remove exploded", error_code=f"{stage}_failed")

    monkeypatch.setattr(remove_module, "resolve_ingest_paths", lambda *_a, **_k: paths)
    monkeypatch.setattr(remove_module, "run_catalog_cli", failing_cli)
    monkeypatch.setattr(
        ingest_module,
        "build_besedy_ingest_client_from_env",
        lambda: SimpleNamespace(
            report_completion=lambda *, intake_id, report: reports.append(report.to_payload())
        ),
    )

    with pytest.raises(remove_module.IngestFlowError):
        remove_module.remove_recording_flow(
            catalog_id=CATALOG_ID, intake_id=INTAKE_ID, audio_hash=NEW_HASH
        )

    assert reports == [
        {
            "status": "FAILED",
            "audioHash": None,
            "errorCode": "catalog_remove_failed",
            "errorMessage": "remove exploded",
        }
    ]


# --- completion client --------------------------------------------------------


def _serve(handler_factory):  # type: ignore[no-untyped-def]
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_factory)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def test_ingest_client_posts_completion_with_bearer() -> None:
    seen: list[dict[str, object]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            return

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            seen.append(
                {"path": self.path, "auth": self.headers.get("Authorization"), "payload": payload}
            )
            body = json.dumps({"ok": True}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server, thread = _serve(Handler)
    try:
        client = BesedyIngestClient(
            BesedyIngestClientConfig(
                base_url=f"http://127.0.0.1:{server.server_address[1]}",
                bearer_token="secret-1",
            )
        )
        response = client.report_completion(
            intake_id=INTAKE_ID,
            report=IngestCompletionReport(
                status=IngestCompletionStatus.SUCCEEDED, audio_hash=NEW_HASH
            ),
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert response == {"ok": True}
    assert seen == [
        {
            "path": f"/api/internal/ingest/{INTAKE_ID}/complete",
            "auth": "Bearer secret-1",
            "payload": {
                "status": "SUCCEEDED",
                "audioHash": NEW_HASH,
                "errorCode": None,
                "errorMessage": None,
            },
        }
    ]


def test_ingest_client_maps_http_errors_and_retryability() -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args: object) -> None:
            return

        def do_POST(self) -> None:  # noqa: N802
            body = json.dumps({"error": "intake not found"}).encode("utf-8")
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server, thread = _serve(Handler)
    try:
        client = BesedyIngestClient(
            BesedyIngestClientConfig(
                base_url=f"http://127.0.0.1:{server.server_address[1]}", bearer_token="s"
            )
        )
        with pytest.raises(IngestClientError) as failure:
            client.report_completion(
                intake_id=INTAKE_ID,
                report=IngestCompletionReport(status=IngestCompletionStatus.FAILED),
            )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert failure.value.status_code == 404
    assert failure.value.retryable is False
    assert "intake not found" in str(failure.value)
    assert IngestClientError("x", status_code=503).retryable is True


def test_ingest_client_from_env_requires_configuration(monkeypatch) -> None:
    monkeypatch.delenv("BESEDY_INTERNAL_BASE_URL", raising=False)
    monkeypatch.delenv("BESEDY_JOB_SERVICE_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="BESEDY_INTERNAL_BASE_URL"):
        ingest_client_module.build_besedy_ingest_client_from_env()
