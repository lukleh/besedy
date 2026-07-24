"""Catalog subcommand package.

This module now re-exports helpers from focused submodules to keep imports
lightweight while preserving the existing public surface that callers expect.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

from besedy.commands.catalog.default_paths import (
    ALREADY_EXISTS_REASON,
    get_default_archived_symlink,
    get_default_catalog_symlink,
    get_default_duplicates_symlink,
    get_default_joined_symlink,
    get_default_loudness_symlink,
    get_default_normalized_symlink,
)

__all__ = [
    # Getter functions for catalog symlinks
    "get_default_catalog_symlink",
    "get_default_loudness_symlink",
    "get_default_normalized_symlink",
    "get_default_duplicates_symlink",
    "get_default_archived_symlink",
    "get_default_joined_symlink",
    # Constants
    "ALREADY_EXISTS_REASON",
    "METADATA_LOGGER",
    "DUPLICATES_CSV_COLUMNS",
    # Classes
    "Ansi",
    # Functions - shared utilities
    "color_text",
    "_ensure_chain_alignment",
    "validate_symlink_can_be_created",
    "create_or_update_symlink",
    "resolve_catalog_csv",
    "load_audio_rows",
    # Workflow setup utilities
    "resolve_and_load_catalog",
    "extract_run_info",
    "setup_output_root",
    "prepare_workflow_env",
    "validate_staged_audio",
    "print_validation_errors",
    "detect_logical_cpus",
    "parse_positive_int",
    "print_duplicates",
    "print_duration_summary",
    "print_workflow_summary",
    "write_duplicates_csv",
    "format_duration",
    "probe_decoded_duration",
    "get_audio_metadata",
    "get_basic_metadata",
    "get_loudness_metrics",
    "enrich_records",
    "enrich_basic_records",
    # Command handlers
    "handle_create",
    "handle_merge",
    "handle_add",
    "handle_check",
    "handle_check_durations",
    "handle_clean",
    "handle_stage_audio",
    "handle_validate",
    "handle_transcribe",
    "handle_diarize",
    "handle_cluster_speakers",
    "handle_export_transcripts",
    "handle_find_duplicates",
    "handle_archive",
    "handle_run_pipeline",
    "handle_loudness",
    "handle_join",
]


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    # UI helpers
    "Ansi": ("besedy.commands.catalog.ui", "Ansi"),
    "color_text": ("besedy.commands.catalog.ui", "color_text"),
    "print_duplicates": ("besedy.commands.catalog.ui", "print_duplicates"),
    "print_duration_summary": ("besedy.commands.catalog.ui", "print_duration_summary"),
    "print_workflow_summary": ("besedy.commands.catalog.ui", "print_workflow_summary"),
    "write_duplicates_csv": ("besedy.commands.catalog.ui", "write_duplicates_csv"),
    "DUPLICATES_CSV_COLUMNS": ("besedy.commands.catalog.ui", "DUPLICATES_CSV_COLUMNS"),
    # Symlink / alignment helpers
    "_ensure_chain_alignment": ("besedy.commands.catalog.symlink", "_ensure_chain_alignment"),
    "validate_symlink_can_be_created": (
        "besedy.commands.catalog.symlink",
        "validate_symlink_can_be_created",
    ),
    "create_or_update_symlink": ("besedy.commands.catalog.symlink", "create_or_update_symlink"),
    # CSV helpers
    "resolve_catalog_csv": ("besedy.commands.catalog.csv_utils", "resolve_catalog_csv"),
    "load_audio_rows": ("besedy.commands.catalog.csv_utils", "load_audio_rows"),
    # Workflow setup utilities
    "resolve_and_load_catalog": (
        "besedy.commands.catalog.workflow_setup",
        "resolve_and_load_catalog",
    ),
    "extract_run_info": ("besedy.commands.catalog.workflow_setup", "extract_run_info"),
    "setup_output_root": ("besedy.commands.catalog.workflow_setup", "setup_output_root"),
    "prepare_workflow_env": ("besedy.commands.catalog.workflow_setup", "prepare_workflow_env"),
    # Validation helpers
    "validate_staged_audio": ("besedy.commands.catalog.validation", "validate_staged_audio"),
    "print_validation_errors": ("besedy.commands.catalog.validation", "print_validation_errors"),
    # System helpers
    "detect_logical_cpus": ("besedy.commands.catalog.system", "detect_logical_cpus"),
    "parse_positive_int": ("besedy.commands.catalog.system", "parse_positive_int"),
    # Metadata helpers
    "METADATA_LOGGER": ("besedy.commands.catalog.metadata", "METADATA_LOGGER"),
    "format_duration": ("besedy.commands.catalog.metadata", "format_duration"),
    "probe_decoded_duration": ("besedy.commands.catalog.metadata", "probe_decoded_duration"),
    "get_audio_metadata": ("besedy.commands.catalog.metadata", "get_audio_metadata"),
    "get_basic_metadata": ("besedy.commands.catalog.metadata", "get_basic_metadata"),
    "get_loudness_metrics": ("besedy.commands.catalog.metadata", "get_loudness_metrics"),
    "enrich_records": ("besedy.commands.catalog.metadata", "enrich_records"),
    "enrich_basic_records": ("besedy.commands.catalog.metadata", "enrich_basic_records"),
    # Command handlers
    "handle_create": ("besedy.commands.catalog.create", "handle_create"),
    "handle_merge": ("besedy.commands.catalog.merge", "handle_merge"),
    "handle_add": ("besedy.commands.catalog.add", "handle_add"),
    "handle_check": ("besedy.commands.catalog.check", "handle_check"),
    "handle_check_durations": ("besedy.commands.catalog.check_durations", "handle_check_durations"),
    "handle_clean": ("besedy.commands.catalog.clean", "handle_clean"),
    "handle_stage_audio": ("besedy.commands.catalog.stage", "handle_stage_audio"),
    "handle_validate": ("besedy.commands.catalog.validate", "handle_validate"),
    "handle_transcribe": ("besedy.commands.catalog.transcribe", "handle_transcribe"),
    "handle_diarize": ("besedy.commands.catalog.diarize", "handle_diarize"),
    "handle_cluster_speakers": ("besedy.commands.catalog.speakers", "handle_cluster_speakers"),
    "handle_export_transcripts": ("besedy.commands.catalog.extract", "handle_export_transcripts"),
    "handle_find_duplicates": ("besedy.commands.catalog.duplicates", "handle_find_duplicates"),
    "handle_archive": ("besedy.commands.catalog.archive", "handle_archive"),
    "handle_run_pipeline": ("besedy.commands.catalog.pipeline", "handle_run_pipeline"),
    "handle_loudness": ("besedy.commands.catalog.loudness", "handle_loudness"),
    "handle_join": ("besedy.commands.catalog.join", "handle_join"),
}


def __getattr__(name: str) -> Any:
    try:
        module_name, attribute_name = _LAZY_IMPORTS[name]
    except KeyError as exc:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}") from exc

    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(__all__) | set(globals()))
