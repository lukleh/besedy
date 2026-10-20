"""Skip tests of scripts that only run on the Linux prod host when its tools are missing.

The backup scripts in web/scripts/ and the production branch of
scripts/run_web_compose.sh use util-linux `flock` and GNU coreutils
(`date -d`, `stat -c`, `realpath -e`). They are written for the host and
tested on CI's Ubuntu; on macOS (BSD tools, no flock) those tests are
skipped rather than failing.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

_PROBES = {
    "flock": None,
    "date -d": ["date", "-d", "@0", "+%s"],
    "stat -c": ["stat", "-c", "%s", "/"],
    "realpath -e": ["realpath", "-e", "/"],
}


def _works(name: str) -> bool:
    command = _PROBES[name]
    if command is None:
        return shutil.which(name) is not None
    try:
        return subprocess.run(command, capture_output=True, check=False).returncode == 0
    except OSError:
        return False


def requires_linux_host_tools(*names: str) -> pytest.MarkDecorator:
    """Skip unless each of ``names`` (keys of the probes above) works here."""
    missing = [name for name in names if not _works(name)]
    return pytest.mark.skipif(
        bool(missing),
        reason=f"needs the Linux host's {', '.join(missing)} (GNU coreutils/util-linux)",
    )
