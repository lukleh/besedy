"""The suite must never reach the operator's configured Prefect API."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

prefect_settings = pytest.importorskip("prefect.settings")


def test_prefect_uses_throwaway_home_and_no_api_url() -> None:
    settings = prefect_settings.get_current_settings()

    assert settings.api.url is None
    assert Path(settings.home) == Path(os.environ["PREFECT_HOME"])
    assert Path(settings.home) != Path.home() / ".prefect"
