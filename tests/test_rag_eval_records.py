from __future__ import annotations

import json
from pathlib import Path

import pytest

from besedy.lib.rag_eval_records import load_eval_records, parse_eval_targets, record_query


def test_eval_record_parser_accepts_query_and_time_aliases() -> None:
    record = {
        "id": "oblique-1",
        "query": "find the implicit distinction",
        "targets": [
            {
                "audio_hash": "A" * 64,
                "start_seconds": 10,
                "end_seconds": 20,
            }
        ],
    }

    targets = parse_eval_targets(record)

    assert record_query(record) == "find the implicit distinction"
    assert len(targets) == 1
    assert targets[0].audio_hash == "a" * 64
    assert targets[0].matches(
        chunk_id="chunk-1",
        audio_hash="a" * 64,
        start_sec=12,
        end_sec=18,
    )
    assert not targets[0].matches(
        chunk_id="chunk-2",
        audio_hash="a" * 64,
        start_sec=0,
        end_sec=5,
    )


@pytest.mark.parametrize(
    ("target", "message"),
    [
        (
            {
                "audio_hash": "a" * 64,
                "start_seconds": 10,
                "end_second": 20,
            },
            "unsupported time field",
        ),
        (
            {
                "audio_hash": "a" * 64,
                "start_seconds": 10,
                "end_seconds": "12:30",
            },
            "must be a finite number",
        ),
        (
            {
                "audio_hash": "a" * 64,
                "start_seconds": 10,
                "end_seconds": 10,
            },
            "start < end",
        ),
        (
            {
                "audio_hash": "a" * 64,
                "start_seconds": 10,
            },
            "both start and end",
        ),
    ],
)
def test_eval_record_parser_rejects_malformed_time_spans(
    target: dict[str, object],
    message: str,
) -> None:
    record = {
        "id": "broken-span",
        "query": "find something",
        "targets": [target],
    }

    with pytest.raises(ValueError, match=message):
        parse_eval_targets(record)


@pytest.mark.parametrize(
    ("audio_hash", "message"),
    [
        ("abc", "64-character SHA-256"),
        ("g" * 64, "64-character SHA-256"),
    ],
)
def test_eval_record_parser_rejects_malformed_audio_hashes(
    audio_hash: str,
    message: str,
) -> None:
    record = {
        "id": "broken-hash",
        "query": "find something",
        "targets": [{"audio_hash": audio_hash}],
    }

    with pytest.raises(ValueError, match=message):
        parse_eval_targets(record)


@pytest.mark.parametrize(
    ("target", "message"),
    [
        (
            {
                "audio_hash": "a" * 64,
                "start_seconds": -10,
                "end_seconds": 10,
            },
            "non-negative",
        ),
        (
            {
                "chunk_id": "chunk-1",
                "start_seconds": 10,
                "end_seconds": 20,
            },
            "require audio_hash",
        ),
    ],
)
def test_eval_record_parser_rejects_meaningless_time_spans(
    target: dict[str, object],
    message: str,
) -> None:
    record = {
        "id": "broken-span",
        "query": "find something",
        "targets": [target],
    }

    with pytest.raises(ValueError, match=message):
        parse_eval_targets(record)


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ([], "at least one evaluation record"),
        ([{"query": "valid", "targets": [{"audio_hash": "a" * 64}]}, "not-an-object"], "record 1"),
        ([{"qurey": "typo", "targets": [{"audio_hash": "a" * 64}]}], "question.*query"),
        ([{"query": "missing targets", "target": [{"audio_hash": "a" * 64}]}], "one target"),
    ],
)
def test_load_eval_records_rejects_malformed_records(
    tmp_path: Path,
    payload: list[object],
    message: str,
) -> None:
    path = tmp_path / "eval.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        load_eval_records(path)
