"""The suite never writes runtime state into the operator's home directory."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from besedy.core.paths_runtime import FFMPEG_LOG_DIR, resolve_state_home


def test_state_home_is_a_suite_temp_directory() -> None:
    state_home = resolve_state_home()

    assert Path(os.environ["BESEDY_STATE_HOME"]) == state_home
    assert state_home.is_relative_to(tempfile.gettempdir())
    assert not state_home.is_relative_to(Path.home() / ".local" / "state")


def test_import_time_log_directory_is_inside_the_suite_state_home() -> None:
    # Resolved when besedy.core.paths_runtime was first imported, so this
    # fails if conftest sets BESEDY_STATE_HOME too late.
    assert FFMPEG_LOG_DIR.is_relative_to(Path(os.environ["BESEDY_STATE_HOME"]))
