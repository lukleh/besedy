"""Core system utilities.

Platform-agnostic helpers for CPU detection and other system operations.
"""

from __future__ import annotations

import os


def detect_logical_cpus() -> int:
    """Detect the number of logical CPUs available.

    Uses sched_getaffinity on Linux for container-aware limits,
    falls back to os.cpu_count().

    Returns:
        Number of logical CPUs (minimum 1).
    """
    count: int | None = None
    if hasattr(os, "sched_getaffinity"):
        try:
            count = len(os.sched_getaffinity(0))
        except Exception:
            count = None
    if count is None:
        count = os.cpu_count()
    return max(1, count or 1)
