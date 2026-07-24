"""Shared factories for workflow-config test fixtures."""

from __future__ import annotations

from typing import Any

from besedy.lib.workflow.config import WorkflowConfig


def make_workflow_config(**overrides: Any) -> WorkflowConfig:
    """Build a minimal transcription WorkflowConfig with sensible defaults."""
    values: dict[str, Any] = {
        "workflow_id": "faster-whisper",
        "workflow_type": "transcription",
        "workflow_label": "faster-whisper",
        "model_name": "large-v3",
        "vad_model": "silero_vad_v6",
        "language": "cs",
    }
    values.update(overrides)
    return WorkflowConfig(**values)


def make_workflow_entry(workflow_id: str = "faster-whisper", **overrides: Any) -> dict[str, Any]:
    """Build a minimal transcription_workflows TOML entry for loader tests."""
    entry: dict[str, Any] = {
        "workflow_id": workflow_id,
        "workflow_label": workflow_id,
        "model": "test-model",
        "vad_model": "test-vad",
    }
    if workflow_id == "canary-nemo":
        entry["strategy"] = "greedy"
    elif workflow_id == "canary-nemo-beam":
        entry["strategy"] = "beam"
        entry["align_model"] = "test-aligner"
    entry.update(overrides)
    return entry
