"""Workflow configuration objects for transcription and diarization pipelines."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import TypedDict

from besedy.config.settings import get_config
from besedy.core.paths_common import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
)
from besedy.lib.backend_ids import TRANSCRIPTION_WORKFLOW_IDS
from besedy.lib.workflow.language import (
    language_output_component,
    resolve_inference_language,
)

__all__ = [
    "WorkflowConfig",
    "language_output_component",
    "matches_language",
    "resolve_inference_language",
    "get_workflow_config",
    "get_workflow_label",
    "list_workflow_ids",
    "get_transcription_workflows",
    "get_diarization_workflows",
    "select_transcription_workflow",
]


@dataclass(frozen=True)
class WorkflowConfig:
    """Configuration for a transcription or diarization workflow."""

    workflow_id: str
    workflow_type: str  # "transcription" | "diarization"
    workflow_label: str
    model_name: str
    vad_model: str | None = None
    align_model: str | None = None
    decode_strategy: str | None = None
    language: str = "auto"
    output_filename: str = "transcript.json"

    vram_per_instance_gb: float = 4.0
    safety_margin_gb: float = 0.5
    safety_margin_percent: float | None = None
    default_parallel: int = 1
    aggressive_fill: bool = False

    pipeline_default: bool = True
    expected_default: bool = True

    def output_component(self, sanitize_fn) -> str:
        model_component = sanitize_fn(self.model_name)
        if self.decode_strategy:
            model_component = f"{model_component}[{self.decode_strategy}]"
        components = [model_component]
        if self.vad_model:
            components.append(sanitize_fn(self.vad_model))
        if self.align_model:
            components.append(sanitize_fn(self.align_model))
        language_component = language_output_component(self.language, sanitize_fn)
        if self.workflow_type == "transcription" and language_component:
            components.append(language_component)
        return "@".join(components)


class WorkflowDefaults(TypedDict, total=False):
    vram_per_instance_gb: float
    safety_margin_gb: float
    safety_margin_percent: float | None
    default_parallel: int
    aggressive_fill: bool


_TRANSCRIPTION_DEFAULTS: dict[str, WorkflowDefaults] = {
    "faster-whisper": {
        "vram_per_instance_gb": 4.0,
        "safety_margin_percent": 0.10,
        "default_parallel": 3,
        "aggressive_fill": False,
    },
    "canary-nemo": {
        "vram_per_instance_gb": 9.0,
        "safety_margin_gb": 0.5,
        "default_parallel": 1,
        "aggressive_fill": True,
    },
    "canary-nemo-beam": {
        "vram_per_instance_gb": 9.0,
        "safety_margin_gb": 0.5,
        "default_parallel": 1,
        "aggressive_fill": True,
    },
    "whisperx": {
        "vram_per_instance_gb": 6.0,
        "safety_margin_percent": 0.10,
        "default_parallel": 1,
        "aggressive_fill": False,
    },
    "qwen3-asr": {
        "vram_per_instance_gb": 9.0,
        "safety_margin_percent": 0.10,
        "default_parallel": 1,
        "aggressive_fill": False,
    },
}

_DIARIZATION_CONFIGS: list[WorkflowConfig] = [
    WorkflowConfig(
        workflow_id="pyannote",
        workflow_type="diarization",
        workflow_label=PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
        model_name=PYANNOTE_DIARIZATION_MODEL_NAME,
        output_filename="speakers.json",
        # Measured ~4.1GB resident per container plus a peak spike during the
        # embeddings stage; 3.0GB under-counted and over-subscribed the GPU
        # (e.g. 3 concurrent workers on a 16GB card OOM'd). aggressive_fill is
        # only safe for stable-memory workflows, which pyannote is not, so it is
        # disabled here to avoid packing past the embeddings-stage peak.
        vram_per_instance_gb=6.0,
        safety_margin_gb=0.2,
        default_parallel=1,
        aggressive_fill=False,
    ),
]


def _build_transcription_workflows() -> list[WorkflowConfig]:
    cfg = get_config()
    configs: list[WorkflowConfig] = []
    for entry in cfg.transcription_workflows:
        defaults = _TRANSCRIPTION_DEFAULTS.get(entry.workflow_id)
        if defaults is None:
            raise KeyError(f"Missing defaults for transcription workflow {entry.workflow_id!r}")
        configs.append(
            WorkflowConfig(
                workflow_id=entry.workflow_id,
                workflow_type="transcription",
                workflow_label=entry.workflow_label,
                model_name=entry.model,
                vad_model=entry.vad_model,
                align_model=entry.align_model,
                decode_strategy=entry.strategy,
                language=entry.language,
                output_filename="transcript.json",
                pipeline_default=entry.pipeline_default,
                expected_default=entry.expected_default,
                **defaults,
            )
        )
    return configs


def matches_language(cfg: WorkflowConfig, language: str) -> bool:
    """Return True when a configured workflow matches a requested language value."""
    return cfg.language.casefold() == language.strip().casefold()


def get_transcription_workflows(
    *,
    pipeline_only: bool = False,
    expected_only: bool = False,
    workflow_id: str | None = None,
    model_name: str | None = None,
    language: str | None = None,
) -> list[WorkflowConfig]:
    configs = [cfg for cfg in _build_transcription_workflows()]
    if workflow_id:
        configs = [cfg for cfg in configs if cfg.workflow_id == workflow_id]
    if model_name:
        configs = [cfg for cfg in configs if cfg.model_name == model_name]
    if language:
        configs = [cfg for cfg in configs if matches_language(cfg, language)]
    if pipeline_only:
        configs = [cfg for cfg in configs if cfg.pipeline_default]
    if expected_only:
        configs = [cfg for cfg in configs if cfg.expected_default]
    return configs


def select_transcription_workflow(
    workflow_id: str,
    *,
    model_name: str | None = None,
    language: str | None = None,
) -> WorkflowConfig:
    """Return the configured variant a workflow CLI run should inherit from.

    Prefers variants matching the requested model/language. When the filters
    match nothing, falls back to the primary configured variant with a stderr
    warning so CLI overrides never silently masquerade as a configured variant.
    """
    configs = get_transcription_workflows(
        workflow_id=workflow_id, model_name=model_name, language=language
    )
    fell_back = False
    if not configs and (model_name or language):
        configs = get_transcription_workflows(workflow_id=workflow_id)
        fell_back = bool(configs)
    if not configs:
        raise RuntimeError(f"No {workflow_id} workflow configured in besedy.toml.")
    preferred = [cfg for cfg in configs if cfg.pipeline_default]
    selected = preferred[0] if preferred else configs[0]
    if fell_back:
        requested = ", ".join(
            part
            for part in (
                f"model {model_name!r}" if model_name else "",
                f"language {language!r}" if language else "",
            )
            if part
        )
        print(
            f"Warning: no configured {workflow_id} variant matches {requested}; "
            f"using defaults from the {selected.model_name} entry.",
            file=sys.stderr,
        )
    return selected


def get_diarization_workflows() -> list[WorkflowConfig]:
    return list(_DIARIZATION_CONFIGS)


def get_workflow_label(workflow_id: str) -> str:
    configs = (
        get_transcription_workflows(workflow_id=workflow_id)
        if workflow_id in TRANSCRIPTION_WORKFLOW_IDS
        else [cfg for cfg in _DIARIZATION_CONFIGS if cfg.workflow_id == workflow_id]
    )
    if not configs:
        available = ", ".join(sorted(list_workflow_ids()))
        raise KeyError(f"Unknown workflow_id '{workflow_id}'. Available workflows: {available}")
    labels = {cfg.workflow_label for cfg in configs}
    if len(labels) != 1:
        raise ValueError(f"Workflow {workflow_id} has inconsistent labels: {sorted(labels)}")
    return labels.pop()


def get_workflow_config(
    workflow_id: str,
    *,
    model_name: str | None = None,
    decode_strategy: str | None = None,
    align_model: str | None = None,
) -> WorkflowConfig:
    if workflow_id in TRANSCRIPTION_WORKFLOW_IDS:
        configs = get_transcription_workflows(workflow_id=workflow_id)
        if model_name:
            configs = [cfg for cfg in configs if cfg.model_name == model_name]
        if decode_strategy:
            configs = [cfg for cfg in configs if cfg.decode_strategy == decode_strategy]
        if align_model:
            configs = [cfg for cfg in configs if cfg.align_model == align_model]
        if not configs:

            def _identity(value: str) -> str:
                return value

            available = ", ".join(
                cfg.output_component(_identity)
                for cfg in get_transcription_workflows(workflow_id=workflow_id)
            )
            raise KeyError(f"Unknown workflow variant for '{workflow_id}'. Available: {available}")
        if len(configs) == 1:
            return configs[0]
        preferred = [cfg for cfg in configs if cfg.pipeline_default]
        return preferred[0] if preferred else configs[0]

    configs = [cfg for cfg in _DIARIZATION_CONFIGS if cfg.workflow_id == workflow_id]
    if not configs:
        available = ", ".join(sorted(list_workflow_ids()))
        raise KeyError(f"Unknown workflow_id '{workflow_id}'. Available workflows: {available}")
    return configs[0]


def list_workflow_ids() -> list[str]:
    transcription_ids = {cfg.workflow_id for cfg in get_transcription_workflows()}
    diarization_ids = {cfg.workflow_id for cfg in _DIARIZATION_CONFIGS}
    return sorted(transcription_ids | diarization_ids)
