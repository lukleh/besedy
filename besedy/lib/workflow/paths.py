"""Generic path building for workflow outputs."""

from __future__ import annotations

import re
from pathlib import Path

from besedy.core.paths import (
    iter_transcript_paths,
    parse_transcript_components,
    require_valid_hash_stem,
    sanitize_component,
)
from besedy.core.paths import (
    resolve_transcripts_root as core_resolve_transcripts_root,
)

from .config import WorkflowConfig, get_workflow_config

__all__ = [
    # Sanitization functions
    "sanitize_component",
    "sanitize_model_identifier",
    # Path builder class
    "WorkflowPathBuilder",
    "path_builder",
    # Convenience functions
    "transcripts_dir",
    "artifact_path",
    "artifact_matches",
    "artifact_exists",
    "get_transcript_backend_paths",
    # Diarization helpers
    "setup_diarization_output_dir",
]


def _looks_like_path(model_ref: str) -> bool:
    """Return True if model_ref should be treated as a local filesystem path."""
    if model_ref.startswith(("/", "./", "../", "~")):
        return True
    if re.match(r"^[A-Za-z]:[\\/]", model_ref):
        return True
    return Path(model_ref).exists()


def sanitize_model_identifier(model_ref: str) -> str:
    """Normalise a model reference (remote path or local .nemo) into a safe identifier."""
    if model_ref.endswith(".nemo"):
        token = Path(model_ref).stem
    elif _looks_like_path(model_ref):
        token = Path(model_ref).name
    else:
        token = model_ref
    token = token.replace("\\", "/")
    token = token.replace("/", "_")
    token = token.replace(".", "_")
    token = re.sub(r"[^0-9A-Za-z_-]+", "_", token)
    token = re.sub(r"_+", "_", token).strip("_")
    return token.lower()


def _resolve_transcripts_root(root: Path | str | None, project_root: Path) -> Path:
    """Resolve a transcripts directory relative to the project root.

    When root is None/empty, uses core_resolve_transcripts_root() which
    respects the text_data_dir configuration setting.
    """
    if root is None or root == "":
        return core_resolve_transcripts_root()
    candidate = Path(root)
    return candidate if candidate.is_absolute() else project_root / candidate


class WorkflowPathBuilder:
    """Generic path builder for workflow outputs.

    Replaces the 27+ workflow-specific path functions with a single
    parameterized class.
    """

    def __init__(self, config: WorkflowConfig, project_root: Path | None = None):
        """Initialize path builder.

        Args:
            config: WorkflowConfig for this workflow.
            project_root: Repository root. Defaults to auto-detection.
        """
        self.config = config
        if project_root is None:
            # besedy/lib/workflow/paths.py -> besedy/ -> project root
            self._project_root = Path(__file__).resolve().parent.parent.parent.parent
        else:
            self._project_root = project_root

    def _resolve_root(self, root: Path | str | None) -> Path:
        """Resolve transcripts root directory."""
        return _resolve_transcripts_root(root, self._project_root)

    def output_component(self) -> str:
        """Return the model@vad or model directory component."""
        return self.config.output_component(sanitize_model_identifier)

    def workflow_dir(self, root: Path | str | None = None) -> Path:
        """Return workflow output directory: root / workflow_label / output_component.

        Args:
            root: Transcripts root (defaults to project's transcripts/).
        """
        return self._resolve_root(root) / self.config.workflow_label / self.output_component()

    def artifact_path(
        self,
        hash_component: str,
        root: Path | str | None = None,
    ) -> Path:
        """Return the expected artifact path for a hash.

        Args:
            hash_component: Audio file hash (or prefix).
            root: Transcripts root.
        """
        return self.workflow_dir(root) / hash_component / self.config.output_filename

    def glob_matches(
        self,
        hash_component: str,
        root: Path | str | None = None,
    ) -> list[Path]:
        """Glob for artifacts matching hash across model variants.

        Args:
            hash_component: Audio file hash (or prefix).
            root: Transcripts root.

        Returns:
            List of matching artifact paths.
        """
        base = self.workflow_dir(root)
        return list(base.glob(f"{hash_component}/{self.config.output_filename}"))

    def artifact_exists(
        self,
        hash_component: str,
        root: Path | str | None = None,
    ) -> bool:
        """Check if any artifact exists for this hash.

        Args:
            hash_component: Audio file hash.
            root: Transcripts root.
        """
        return bool(self.glob_matches(hash_component, root))


def path_builder(
    workflow: str | WorkflowConfig, project_root: Path | None = None
) -> WorkflowPathBuilder:
    """Factory function for creating a path builder.

    Args:
        workflow: Workflow ID or WorkflowConfig.
        project_root: Optional project root override.
    """
    config = workflow if isinstance(workflow, WorkflowConfig) else get_workflow_config(workflow)
    return WorkflowPathBuilder(config, project_root)


# Convenience functions for common operations


def transcripts_dir(
    workflow_id: str,
    root: Path | str | None = None,
    project_root: Path | None = None,
) -> Path:
    """Return workflow output directory for the specified workflow."""
    return path_builder(workflow_id, project_root).workflow_dir(root)


def artifact_path(
    workflow_id: str,
    hash_component: str,
    root: Path | str | None = None,
    project_root: Path | None = None,
) -> Path:
    """Return expected artifact path for workflow and hash."""
    return path_builder(workflow_id, project_root).artifact_path(hash_component, root)


def artifact_matches(
    workflow_id: str,
    hash_component: str,
    root: Path | str | None = None,
    project_root: Path | None = None,
) -> list[Path]:
    """Return all matching artifacts for workflow and hash."""
    return path_builder(workflow_id, project_root).glob_matches(hash_component, root)


def artifact_exists(
    workflow_id: str,
    hash_component: str,
    root: Path | str | None = None,
    project_root: Path | None = None,
) -> bool:
    """Check if artifact exists for workflow and hash."""
    return path_builder(workflow_id, project_root).artifact_exists(hash_component, root)


def get_transcript_backend_paths(
    transcripts_root: Path | str | None = None,
) -> dict[str, str]:
    """Discover transcript backend paths on disk for all workflow/model variants.

    Returns mapping backend_key -> relative path, where backend_key is
    "{workflow}/{model_component}" (the on-disk directory structure).
    """
    # Resolve relative roots against the project root (like WorkflowPathBuilder)
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    resolved_root = _resolve_transcripts_root(transcripts_root, project_root)

    if not resolved_root.exists():
        return {}

    backend_paths: dict[str, str] = {}
    for transcript_path in iter_transcript_paths(resolved_root):
        components = parse_transcript_components(transcript_path, resolved_root)
        if not components:
            continue
        workflow, model_component, _audio_hash = components
        rel_path = f"{workflow}/{model_component}"
        backend_paths[rel_path] = rel_path

    return dict(sorted(backend_paths.items()))


def setup_diarization_output_dir(
    output_root: Path,
    audio_path: Path,
    model_name: str,
) -> tuple[Path, str]:
    """Setup output directory for diarization results.

    Creates directory structure: {output_root}/{model_name}/{hash}/

    Args:
        output_root: Root directory for outputs (e.g., transcripts/speaker_diarization)
        audio_path: Path to audio file (hash extracted from stem)
        model_name: Model identifier for directory name

    Returns:
        Tuple of (output_dir, hash_component)
    """
    hash_component = require_valid_hash_stem(audio_path)

    # Create output directory: {model}/{hash}/
    # Note: output_root is expected to already include the workflow directory
    # (e.g., transcripts/speaker_diarization when called from batch script)
    model_dir = output_root / model_name
    output_dir = model_dir / hash_component
    output_dir.mkdir(parents=True, exist_ok=True)

    return output_dir, hash_component
