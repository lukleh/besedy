"""VRAM-based parallel instance calculation for GPU workflows."""

from __future__ import annotations

import logging
import subprocess

from .config import WorkflowConfig

__all__ = [
    "get_available_vram_gb",
    "calculate_parallel_instances",
]


def get_available_vram_gb() -> float | None:
    """Get available VRAM in GB using nvidia-smi.

    Returns:
        Available VRAM in GB, or None if detection fails.
    """
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
        )
        free_mb = float(result.stdout.strip().split("\n")[0])
        return free_mb / 1024.0
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError, IndexError):
        return None


def calculate_parallel_instances(config: WorkflowConfig) -> int:
    """Calculate optimal parallel instance count based on VRAM and config.

    Algorithm:
        1. Query available VRAM via nvidia-smi
        2. Subtract safety margin (fixed GB or percentage)
        3. Divide by VRAM per instance
        4. Optionally try to fit more instances if aggressive_fill is enabled

    Args:
        config: WorkflowConfig with VRAM requirements.

    Returns:
        Number of parallel instances to run.
    """
    available_vram = get_available_vram_gb()
    if available_vram is None:
        logging.info(
            "Could not detect available VRAM, using default %s-parallel=%d",
            config.workflow_id,
            config.default_parallel,
        )
        return config.default_parallel

    # Calculate usable VRAM after safety margin
    if config.safety_margin_percent is not None:
        usable_vram = available_vram * (1.0 - config.safety_margin_percent)
    else:
        usable_vram = max(0.0, available_vram - config.safety_margin_gb)

    calculated = max(1, int(usable_vram / config.vram_per_instance_gb))

    # For workflows with stable memory usage, try to squeeze in more instances
    if config.aggressive_fill and config.safety_margin_percent is None:
        while (
            calculated + 1
        ) * config.vram_per_instance_gb + config.safety_margin_gb <= available_vram:
            calculated += 1

    logging.info(
        "Detected %.1fGB available VRAM, setting %s-parallel=%d "
        "(%.1fGB usable / %.1fGB per process)",
        available_vram,
        config.workflow_id,
        calculated,
        usable_vram,
        config.vram_per_instance_gb,
    )
    return calculated
