"""Shared constants for analysis modules.

This module provides a neutral location for constants used across
both lib/ and analyze/ packages, avoiding circular dependencies.
"""

# Tolerance for floating-point time comparisons (in seconds)
from __future__ import annotations

TIME_TOL = 1e-6
