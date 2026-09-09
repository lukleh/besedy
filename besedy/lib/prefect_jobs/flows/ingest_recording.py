"""Prefect flow that ingests a web-uploaded recording into a catalog.

The flow runs on a host worker (it needs the operator's Docker/GPU access for
the pipeline) and only trusts two validated tokens from the web app: the catalog
id and the intake id. Every path is derived from the worker's own configuration.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
from collections import deque
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from prefect import flow, task
from prefect.states import State

from besedy.core.paths import (
    PROJECT_ROOT,
    resolve_catalogs_root,
    resolve_uploads_root,
    sanitize_component,
)
from besedy.lib.catalog.manager import (
    audio_content_sha256sum,
    collect_hashes,
    load_csv,
    resolve_hash_column,
    source_file_sha256,
    write_audio_hash_sidecar,
)
from besedy.lib.internal_ingest_client import (
    BesedyIngestClient,
    IngestClientError,
    IngestCompletionReport,
    IngestCompletionStatus,
    build_besedy_ingest_client_from_env,
)

from ..json_types import JsonDict
from ..models import validate_catalog_id, validate_intake_id, validate_original_filename

INCOMING_DIRNAME = "incoming"
ACCEPTED_DIRNAME = "accepted"
REJECTED_DIRNAME = "rejected"
CLI_OUTPUT_TAIL_LINES = 40
MAX_ERROR_MESSAGE_LENGTH = 2000
# Prefix of the failure message used when the ingest itself finished but the
# completion callback could not be delivered; the web app parses the JSON that
# follows it to recover the outcome.
COMPLETION_REPORT_FAILED_MARKER = "completion_report_failed:"
_SAFE_EXTENSION_RE = re.compile(r"^\.[a-z0-9]{1,8}$")


class IngestFlowError(RuntimeError):
    """Raised for ingest failures that carry a stable error code for the web app."""

    def __init__(self, message: str, *, error_code: str) -> None:
        super().__init__(message)
        self.error_code = error_code


@dataclass(slots=True, frozen=True)
class IngestPaths:
    catalog_id: str
    intake_id: str
    incoming_dir: Path
    accepted_dir: Path
    rejected_dir: Path
    catalog_csv: Path
    lock_path: Path


def resolve_ingest_paths(
    catalog_id: str,
    intake_id: str,
    *,
    uploads_root: Path | None = None,
    catalogs_root: Path | None = None,
) -> IngestPaths:
    catalog_id = validate_catalog_id(catalog_id)
    intake_id = validate_intake_id(intake_id)
    uploads = (uploads_root or resolve_uploads_root()).expanduser()
    catalogs = (catalogs_root or resolve_catalogs_root()).expanduser()
    catalog_uploads = uploads / catalog_id
    return IngestPaths(
        catalog_id=catalog_id,
        intake_id=intake_id,
        incoming_dir=catalog_uploads / INCOMING_DIRNAME / intake_id,
        accepted_dir=catalog_uploads / ACCEPTED_DIRNAME / intake_id,
        rejected_dir=catalog_uploads / REJECTED_DIRNAME / intake_id,
        catalog_csv=catalogs / f"audio_catalog_{catalog_id}.csv",
        lock_path=catalogs / f".ingest-{catalog_id}.lock",
    )


def find_intake_source(incoming_dir: Path) -> Path:
    """Return the single uploaded file inside an intake directory."""
    if not incoming_dir.is_dir():
        raise IngestFlowError(
            f"Intake directory not found: {incoming_dir}", error_code="intake_missing"
        )
    candidates = [
        path
        for path in sorted(incoming_dir.iterdir())
        if path.is_file() and not path.name.startswith(".") and path.suffix != ".audiohash"
    ]
    if len(candidates) != 1:
        raise IngestFlowError(
            f"Intake directory must contain exactly one file, found {len(candidates)}: "
            f"{incoming_dir}",
            error_code="intake_invalid",
        )
    return candidates[0]


def catalog_hashes(catalog_csv: Path) -> set[str]:
    columns, rows = load_csv(catalog_csv, encoding="utf-8")
    hash_column = resolve_hash_column(columns, catalog_csv, preferred="Hash")
    return {value.lower() for value in collect_hashes(rows, hash_column=hash_column)}


def accepted_filename(original_filename: str, source: Path) -> str:
    """Display-derived name inside the per-intake accepted directory."""
    stem = sanitize_component(Path(original_filename).stem) or "recording"
    extension = source.suffix.lower()
    if not _SAFE_EXTENSION_RE.fullmatch(extension):
        extension = ""
    return f"{stem}{extension}"


def catalog_cli_command(args: Sequence[str]) -> list[str]:
    return [sys.executable, "-m", "besedy.cli.catalog", *args]


def run_catalog_cli(
    args: Sequence[str],
    *,
    stage: str,
    cwd: Path = PROJECT_ROOT,
    log: Callable[[str], None] = print,
) -> None:
    """Run a catalog CLI subcommand in its own process group and stream its output.

    A fresh interpreter mirrors what the operator runs by hand and keeps the CLI's
    ``sys.exit``/signal handling out of the Prefect flow process. The process group
    lets a cancelled flow terminate the whole tree, including Docker backend runs.
    """
    command = catalog_cli_command(args)
    log(f"[{stage}] $ {' '.join(command)}")
    tail: deque[str] = deque(maxlen=CLI_OUTPUT_TAIL_LINES)
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        assert process.stdout is not None
        for line in process.stdout:
            rendered = line.rstrip()
            tail.append(rendered)
            log(f"[{stage}] {rendered}")
        return_code = process.wait()
    finally:
        if process.poll() is None:
            _terminate_process_group(process)
    if return_code != 0:
        detail = "\n".join(tail).strip()
        raise IngestFlowError(
            f"{stage} exited with code {return_code}.\n{detail}".strip(),
            error_code=f"{stage}_failed",
        )


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=30)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


@contextmanager
def catalog_ingest_lock(lock_path: Path) -> Iterator[None]:
    """Serialise ingests per catalog so two flows never edit the same CSVs at once."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _should_retry_report(_task: Any, _task_run: Any, state: State[Any]) -> bool:
    exc = state.result(raise_on_failure=False, retry_result_failure=False)
    return isinstance(exc, IngestClientError) and exc.retryable


@task
def validate_intake(incoming_dir: str, catalog_csv: str) -> str:
    csv_path = Path(catalog_csv)
    if not csv_path.is_file():
        raise IngestFlowError(f"Catalog CSV not found: {csv_path}", error_code="catalog_missing")
    return str(find_intake_source(Path(incoming_dir)))


@task
def check_duplicate(source_path: str, catalog_csv: str) -> JsonDict:
    source = Path(source_path)
    audio_hash = audio_content_sha256sum(source)
    if audio_hash is None:
        raise IngestFlowError(
            f"ffmpeg could not decode the uploaded file: {source.name}",
            error_code="undecodable_audio",
        )
    existing = catalog_hashes(Path(catalog_csv))
    return {"audio_hash": audio_hash, "duplicate": audio_hash in existing}


@task
def reject_file(source_path: str, rejected_dir: str) -> str:
    source = Path(source_path)
    target_dir = Path(rejected_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / source.name
    shutil.move(str(source), str(target))
    _remove_empty_dir(source.parent)
    return str(target)


@task
def accept_file(
    source_path: str,
    accepted_dir: str,
    original_filename: str,
    audio_hash: str,
) -> str:
    """Move the upload into its own accepted directory, which becomes its Scan Root.

    One directory per intake keeps `catalog add` scoped to this single file: it
    never re-hashes earlier uploads and never picks up files left behind by a
    run that failed after this step.
    """
    source = Path(source_path)
    target_dir = Path(accepted_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / accepted_filename(original_filename, source)
    if target.exists():
        raise IngestFlowError(
            f"Accepted file already exists: {target}", error_code="accepted_exists"
        )
    shutil.move(str(source), str(target))
    write_audio_hash_sidecar(
        Path(f"{target}.audiohash"),
        hash_value=audio_hash,
        filename=target.name,
        source_file_sha256=source_file_sha256(target),
    )
    _remove_empty_dir(source.parent)
    return str(target)


@task
def catalog_add(accepted_dir: str, catalog_csv: str) -> None:
    run_catalog_cli(
        ["add", accepted_dir, "--csv", catalog_csv, "--no-symlink"],
        stage="catalog_add",
    )


@task
def run_pipeline(catalog_csv: str) -> None:
    run_catalog_cli(
        ["run-pipeline", "--csv", catalog_csv, "--no-symlink"],
        stage="run_pipeline",
    )


@task(retries=3, retry_delay_seconds=[5, 15, 45], retry_condition_fn=_should_retry_report)
def report_completion(intake_id: str, report: JsonDict) -> JsonDict:
    client = build_besedy_ingest_client_from_env()
    return _send_report(client, intake_id=intake_id, report=report)


def _send_report(client: BesedyIngestClient, *, intake_id: str, report: JsonDict) -> JsonDict:
    return client.report_completion(
        intake_id=intake_id,
        report=IngestCompletionReport(
            status=IngestCompletionStatus(str(report["status"])),
            audio_hash=_string_or_none(report.get("audioHash")),
            error_code=_string_or_none(report.get("errorCode")),
            error_message=_string_or_none(report.get("errorMessage")),
        ),
    )


def build_failure_report(exc: BaseException) -> JsonDict:
    error_code = exc.error_code if isinstance(exc, IngestFlowError) else "ingest_failed"
    message = str(exc).strip() or exc.__class__.__name__
    return {
        "status": IngestCompletionStatus.FAILED.value,
        "audioHash": None,
        "errorCode": error_code,
        "errorMessage": message[:MAX_ERROR_MESSAGE_LENGTH],
    }


@flow(name="ingest_recording_flow", log_prints=True)
def ingest_recording_flow(
    catalog_id: str,
    intake_id: str,
    original_filename: str,
    requested_by_id: str | None = None,
) -> JsonDict:
    del requested_by_id
    original_filename = validate_original_filename(original_filename)
    paths = resolve_ingest_paths(catalog_id, intake_id)

    with catalog_ingest_lock(paths.lock_path):
        try:
            source = validate_intake(str(paths.incoming_dir), str(paths.catalog_csv))
            identity = check_duplicate(source, str(paths.catalog_csv))
            audio_hash = str(identity["audio_hash"])
            if identity["duplicate"]:
                reject_file(source, str(paths.rejected_dir))
                outcome: JsonDict = {
                    "status": IngestCompletionStatus.REJECTED.value,
                    "audioHash": audio_hash,
                    "errorCode": "duplicate",
                    "errorMessage": (
                        "A recording with the same decoded audio is already in the catalog."
                    ),
                }
            else:
                accept_file(source, str(paths.accepted_dir), original_filename, audio_hash)
                catalog_add(str(paths.accepted_dir), str(paths.catalog_csv))
                run_pipeline(str(paths.catalog_csv))
                outcome = {
                    "status": IngestCompletionStatus.SUCCEEDED.value,
                    "audioHash": audio_hash,
                    "errorCode": None,
                    "errorMessage": None,
                }
        except Exception as exc:
            _report_failure_best_effort(paths.intake_id, exc)
            raise

    try:
        report_completion(paths.intake_id, outcome)
    except Exception as exc:
        # The catalog is already updated; carry the outcome in the failure
        # message so the web app can apply it when it reconciles the run.
        raise IngestFlowError(
            f"Completion report failed: {exc}. "
            f"{COMPLETION_REPORT_FAILED_MARKER}{json.dumps(outcome)}",
            error_code="completion_report_failed",
        ) from exc
    return outcome


def _report_failure_best_effort(intake_id: str, exc: BaseException) -> None:
    try:
        report_completion(intake_id, build_failure_report(exc))
    except Exception as report_exc:  # pragma: no cover - defensive runtime guard
        print(f"Failed to report ingest failure for intake {intake_id}: {report_exc}")


def _remove_empty_dir(path: Path) -> None:
    try:
        path.rmdir()
    except OSError:
        pass


def _string_or_none(value: object) -> str | None:
    if isinstance(value, str):
        rendered = value.strip()
        return rendered or None
    return None
