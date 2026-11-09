"""Catalog subprocess records have an explicit envelope, independent of prose."""

import json
import sys
from pathlib import Path

import pytest

from besedy.lib.job_records import job_record, parse_job_record, validate_job_record


@pytest.mark.parametrize(
    "line", ["[1/9] loudness...", "{broken", "{}", 'prefix {"status":"SUCCEEDED"}']
)
def test_human_output_is_never_a_record(line):
    assert parse_job_record(line) is None


@pytest.mark.parametrize(
    "change", [{"version": 2}, {"version": True}, {"kind": "other"}, {"kind": []}, {"payload": []}]
)
def test_unknown_or_malformed_records_are_rejected(change):
    assert validate_job_record({**job_record("result", {}), **change}) is None


@pytest.mark.parametrize(
    "payload",
    [
        {"label": ""},
        {"label": "stage", "step": 0, "total": 1},
        {"label": "stage", "step": 2, "total": 1},
        {"label": "stage", "step": True, "total": 1},
        {"label": "stage", "step": 1},
    ],
)
def test_progress_must_have_a_label_and_consistent_step_count(payload):
    assert validate_job_record(job_record("progress", payload)) is None


def test_shared_contract_examples():
    examples = json.loads((Path(__file__).parents[1] / "contracts/job-records.json").read_text())
    for record in examples:
        assert parse_job_record(json.dumps(record)) == record


@pytest.mark.jobs
@pytest.mark.optional_dependency
@pytest.mark.parametrize("result_count", [0, 1, 2])
def test_cli_results_require_one_record_and_ignore_surrounding_json(
    monkeypatch, tmp_path, result_count
):
    pytest.importorskip("prefect")
    from besedy.lib.prefect_jobs.flows import ingest_recording as ingest

    result = job_record("result", {"index_dir": "/bundle", "message": "braces { }"})
    output = "\n".join(
        [
            '{"unrelated":"json"}',
            "[1/9] human heading...",
            *([json.dumps(result)] * result_count),
            "diagnostics after result",
        ]
    )
    script = f"print({output!r})"
    monkeypatch.setattr(ingest, "catalog_cli_command", lambda args: [sys.executable, "-c", script])
    if result_count == 1:
        assert (
            ingest.run_catalog_cli([], stage="index", cwd=tmp_path, expect_result=True)
            == result["payload"]
        )
    else:
        with pytest.raises(ingest.IngestFlowError, match="exactly one structured result"):
            ingest.run_catalog_cli([], stage="index", cwd=tmp_path, expect_result=True)
