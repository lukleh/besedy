from __future__ import annotations

import json
from pathlib import Path

from besedy.lib.backend_ids import TRANSCRIPT_META_BACKENDS
from besedy.lib.validation.schema import TRANSCRIPT_META_REQUIRED_FIELDS


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_schema(filename: str) -> dict:
    path = _repo_root() / "docs" / "schemas" / filename
    return json.loads(path.read_text(encoding="utf-8"))


def test_schemas_allow_extra_fields_for_forward_compatibility() -> None:
    for filename in ("transcript.schema.json",):
        schema = _load_schema(filename)
        assert schema.get("additionalProperties") is True


def test_transcript_schema_backend_enum_matches_code() -> None:
    schema = _load_schema("transcript.schema.json")
    backend_enum = schema["properties"]["meta"]["properties"]["backend"]["enum"]
    assert set(backend_enum) == set(TRANSCRIPT_META_BACKENDS)


def test_transcript_schema_required_meta_fields_match_validator() -> None:
    schema = _load_schema("transcript.schema.json")
    required = schema["properties"]["meta"]["required"]
    assert set(required) == set(TRANSCRIPT_META_REQUIRED_FIELDS)
