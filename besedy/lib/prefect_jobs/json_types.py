"""Shared JSON payload types and narrowing helpers for Prefect jobs."""

from __future__ import annotations

from typing import Any, cast

JsonDict = dict[str, Any]


def coerce_json_dict(value: object) -> JsonDict:
    return cast(JsonDict, value) if isinstance(value, dict) else {}


def coerce_json_dict_list(value: object) -> list[JsonDict]:
    if not isinstance(value, list):
        return []
    return [cast(JsonDict, item) for item in value if isinstance(item, dict)]
