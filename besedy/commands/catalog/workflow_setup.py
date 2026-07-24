"""Shared utilities for workflow commands (transcribe, diarize)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from besedy.commands.catalog.csv_utils import load_audio_rows, resolve_catalog_csv
from besedy.commands.catalog.default_paths import get_default_normalized_symlink
from besedy.commands.catalog.symlink import (
    _ensure_chain_alignment,
    create_or_update_symlink,
    validate_symlink_can_be_created,
)
from besedy.core.paths import (
    PROJECT_ROOT,
    extract_timestamp_from_normalized_catalog,
    resolve_catalogs_root,
    resolve_transcripts_parent,
)
from besedy.lib.workflow.common import CsvAudioRow


def _reject_stale_asr_manifests(purpose: str) -> None:
    """Fail fast when manifests from the removed enhanced/ASR pipeline linger.

    Those manifests used to take priority over the normalized catalog when no
    --csv was given, so silently falling back to normalized audio would switch
    inputs without warning.
    """
    catalogs_root = resolve_catalogs_root()
    stale = sorted(
        {
            candidate
            for candidate in [
                catalogs_root / "audio_catalog_asr.csv",
                *catalogs_root.glob("audio_catalog_asr_*.csv"),
            ]
            if candidate.exists() or candidate.is_symlink()
        }
    )
    if not stale:
        return
    names = ", ".join(path.name for path in stale)
    print(
        f"Error: found ASR manifests from the removed enhanced pipeline ({names}). "
        f"These used to take priority when resolving the default catalog for '{purpose}'. "
        "Remove them, or pass --csv with a normalized manifest, to continue.",
        file=sys.stderr,
    )
    sys.exit(1)


def resolve_and_load_catalog(
    csv_arg: Path | None,
    purpose: str,
    limit: int | None,
) -> tuple[Path, list[CsvAudioRow]] | None:
    """Resolve catalog CSV and load audio rows.

    Args:
        csv_arg: Explicit CSV path from command line, or None to use default.
        purpose: Purpose string for error messages (e.g., "transcribe", "diarize").
        limit: Maximum number of rows to load, or None for all.

    Returns:
        (csv_path, rows) tuple on success, or None if no rows found.

    Raises:
        SystemExit: On file not found or parsing error.
    """
    if csv_arg is None:
        _reject_stale_asr_manifests(purpose)
    try:
        csv_path = resolve_catalog_csv(
            csv_arg,
            purpose=purpose,
            default_symlink=get_default_normalized_symlink(),
        )
    except FileNotFoundError as exc:
        print(exc, file=sys.stderr)
        sys.exit(1)

    try:
        rows = load_audio_rows(csv_path, require_duration=False, limit=limit)
    except ValueError as exc:
        print(f"Error while reading {csv_path}: {exc}", file=sys.stderr)
        sys.exit(1)

    if not rows:
        print(f"No rows found in {csv_path}.")
        return None

    return csv_path, rows


def extract_run_info(csv_path: Path) -> tuple[str, str]:
    """Extract run_id and base_name from catalog path.

    Extracts the timestamp from a normalized catalog and returns the
    corresponding transcript run identifier and base directory name.

    Args:
        csv_path: Path to the catalog CSV file.

    Returns:
        (run_id, base_name) tuple where:
        - run_id: Timestamp string
        - base_name: "transcripts"

    Raises:
        SystemExit: If catalog doesn't have a valid timestamp format.
    """
    resolved_path = csv_path.resolve()
    normalized_timestamp = extract_timestamp_from_normalized_catalog(resolved_path)
    if normalized_timestamp:
        return normalized_timestamp, "transcripts"

    print(
        "Error: input catalog must be a timestamped normalized manifest.\n"
        "Expected: audio_catalog_YYYYMMDD_HHMMSS_normalized.csv\n"
        "(ASR manifests from the removed enhanced pipeline are no longer supported.)\n"
        f"Got: {csv_path.name}",
        file=sys.stderr,
    )
    sys.exit(1)


def setup_output_root(
    args: object,
    csv_path: Path,
    run_id: str,
    base_name: str,
) -> bool:
    """Setup output root directory and symlink when not explicitly specified.

    Only acts when args.output_root is None. Sets args.output_root to the
    computed path, creates the directory, and establishes the symlink.

    Args:
        args: Namespace containing output_root (may be None).
        csv_path: Path to the catalog CSV file.
        run_id: Timestamp-based run identifier.
        base_name: Base directory name ("transcripts").

    Returns:
        True on success, False on validation failure.
    """
    catalogs_root = resolve_catalogs_root()
    transcripts_parent = resolve_transcripts_parent()
    transcripts_symlink = transcripts_parent / base_name
    intended_output = transcripts_parent / f"{base_name}_{run_id}"
    no_symlink = bool(getattr(args, "no_symlink", False))

    output_root = getattr(args, "output_root", None)
    if output_root is not None:
        candidate = Path(output_root).expanduser()
        # If user passed the generic symlink path (e.g. "transcripts"), normalize
        # to the timestamped output directory for this run.
        if candidate.name == base_name and (
            candidate == Path(base_name)
            or candidate == transcripts_symlink
            or candidate.resolve(strict=False) == transcripts_symlink.resolve(strict=False)
        ):
            setattr(args, "output_root", None)
        else:
            return True

    # Extract timestamp for chain alignment check
    normalized_timestamp = extract_timestamp_from_normalized_catalog(csv_path.resolve())

    # Only validate chain alignment if the intended output directory already exists.
    # If it doesn't exist, we're starting a fresh run and will update the symlink.
    if intended_output.exists() and normalized_timestamp and not no_symlink:
        if not _ensure_chain_alignment(
            catalog_path=catalogs_root / "audio_catalog.csv",
            normalized_path=csv_path,
            transcripts_root=intended_output,
        ):
            return False

    if not no_symlink:
        try:
            validate_symlink_can_be_created(transcripts_symlink, description=base_name)
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return False

    setattr(args, "output_root", intended_output)
    intended_output.mkdir(parents=True, exist_ok=True)

    if not no_symlink:
        create_or_update_symlink(transcripts_symlink, intended_output, description=base_name)

    return True


def prepare_workflow_env() -> dict[str, str]:
    """Prepare base environment with PYTHONPATH for isolated workflow environments.

    Returns:
        Environment dictionary with PROJECT_ROOT added to PYTHONPATH.
    """
    base_env = os.environ.copy()
    project_root_str = str(PROJECT_ROOT)
    existing_pythonpath = base_env.get("PYTHONPATH", "")
    if existing_pythonpath:
        base_env["PYTHONPATH"] = f"{project_root_str}:{existing_pythonpath}"
    else:
        base_env["PYTHONPATH"] = project_root_str
    return base_env
