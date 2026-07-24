"""Core cleanup logic for removing catalog entries and their derivatives."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from besedy.core.paths import PYANNOTE_DIARIZATION_WORKFLOW_LABEL

# Pattern for timestamped transcript directories: transcripts_YYYYMMDD_HHMMSS[_variant]
_TIMESTAMPED_DIR_PATTERN = re.compile(r"^transcripts_\d{8}_\d{6}(?:_.+)?$")


def _get_transcript_search_roots(transcripts_root: Path) -> list[Path]:
    """Get all directories to search for transcripts.

    Handles both:
    - Direct structure: transcripts_root/<workflow>/<model>/<hash>/
    - Timestamped structure: transcripts_root/transcripts_<timestamp>/<workflow>/<model>/<hash>/

    Always searches transcripts_root directly, plus any timestamped subdirectories.

    Args:
        transcripts_root: The transcripts root directory.

    Returns:
        List of directories to search for transcripts.
    """
    if not transcripts_root.exists():
        return []

    search_roots: list[Path] = []

    # Always search the transcripts_root directly (for direct structure or tests)
    search_roots.append(transcripts_root)

    # Also search all timestamped transcript directories
    for child in transcripts_root.iterdir():
        if not child.is_dir():
            continue
        # Skip symlinks to avoid double-counting (we'll find the target directly)
        if child.is_symlink():
            continue
        # Check for timestamped directories: transcripts_YYYYMMDD_HHMMSS[_variant]
        if _TIMESTAMPED_DIR_PATTERN.match(child.name):
            search_roots.append(child)

    return search_roots


@dataclass
class CleanupTarget:
    """Represents a catalog entry to be cleaned."""

    sha256: str
    original_path: str
    staged_path: Path | None = None
    staged_exists: bool = False
    transcript_dirs: list[Path] = field(default_factory=list)
    diarization_dirs: list[Path] = field(default_factory=list)
    sidecar_files: list[Path] = field(default_factory=list)


@dataclass
class CleanupPlan:
    """Complete plan for catalog cleanup operation."""

    targets: list[CleanupTarget]
    catalog_csv: Path
    normalized_csv: Path | None
    total_staged: int = 0
    total_transcript_dirs: int = 0
    total_diarization_dirs: int = 0
    total_sidecar_files: int = 0
    potential_mount_issue: bool = False
    suspect_parent_dirs: list[str] = field(default_factory=list)


@dataclass
class CleanupResult:
    """Result of cleanup execution."""

    hashes_removed: int = 0
    hashes_failed: int = 0
    staged_removed: int = 0
    transcript_dirs_removed: int = 0
    diarization_dirs_removed: int = 0
    sidecar_files_removed: int = 0
    succeeded_hashes: list[str] = field(default_factory=list)
    failed_hashes: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def detect_missing_originals(
    entries: list[tuple[str, str]],
) -> tuple[list[tuple[str, str]], bool, list[str]]:
    """Detect catalog entries whose original audio files are missing.

    Args:
        entries: List of (sha256, full_path) tuples from catalog.

    Returns:
        Tuple of:
        - List of (sha256, full_path) for missing files
        - Boolean indicating potential mount issue
        - List of suspect parent directories (that don't exist)
    """
    missing: list[tuple[str, str]] = []
    suspect_parents: set[str] = set()
    missing_with_absent_parent = 0

    for sha256, full_path in entries:
        path = Path(full_path)
        if not path.exists():
            missing.append((sha256, full_path))
            # Check if parent directory exists
            if not path.parent.exists():
                missing_with_absent_parent += 1
                suspect_parents.add(str(path.parent))

    # If >50% of missing files have non-existent parents, likely mount issue
    potential_mount_issue = False
    if missing and missing_with_absent_parent > len(missing) * 0.5:
        potential_mount_issue = True

    return missing, potential_mount_issue, sorted(suspect_parents)


def find_staged_file(staging_dir: Path, sha256: str) -> Path | None:
    """Find staged WAV file for a given hash.

    Pattern: <staging_dir>/<hash>.wav

    Uses ``is_file()`` rather than ``exists()`` so that FIFOs, sockets,
    directories, or broken symlinks at the expected path are treated as
    missing instead of crashing the caller.
    """
    staged = staging_dir / f"{sha256}.wav"
    return staged if staged.is_file() else None


def find_transcript_dirs(transcripts_root: Path, sha256: str) -> list[Path]:
    """Find all transcript directories for a given hash.

    Handles both:
    - Direct structure: <transcripts_root>/<workflow>/<model>/<hash>/
    - Timestamped structure: <transcripts_root>/transcripts_<ts>/<workflow>/<model>/<hash>/

    Excludes speaker_diarization directories.
    """
    dirs: list[Path] = []

    for search_root in _get_transcript_search_roots(transcripts_root):
        for workflow_dir in search_root.iterdir():
            if not workflow_dir.is_dir():
                continue
            # Skip diarization - handled separately
            if workflow_dir.name == PYANNOTE_DIARIZATION_WORKFLOW_LABEL:
                continue

            for model_dir in workflow_dir.iterdir():
                if not model_dir.is_dir():
                    continue
                hash_dir = model_dir / sha256
                if hash_dir.exists() and hash_dir.is_dir():
                    dirs.append(hash_dir)

    return dirs


def find_diarization_dirs(transcripts_root: Path, sha256: str) -> list[Path]:
    """Find all diarization directories for a given hash.

    Handles both:
    - Direct structure: <transcripts_root>/speaker_diarization/<model>/<hash>/
    - Timestamped structure: <transcripts_root>/transcripts_<ts>/speaker_diarization/<model>/<hash>/
    """
    dirs: list[Path] = []

    for search_root in _get_transcript_search_roots(transcripts_root):
        diarization_root = search_root / PYANNOTE_DIARIZATION_WORKFLOW_LABEL
        if not diarization_root.exists():
            continue

        for model_dir in diarization_root.iterdir():
            if not model_dir.is_dir():
                continue
            hash_dir = model_dir / sha256
            if hash_dir.exists() and hash_dir.is_dir():
                dirs.append(hash_dir)

    return dirs


def find_sidecar_files(transcript_dirs: list[Path]) -> list[Path]:
    """Find all transcript sidecar files for the given transcript directories."""
    from besedy.core.paths import TRANSCRIPT_SIDECAR_EXTENSIONS

    files: list[Path] = []
    for transcript_dir in transcript_dirs:
        for ext in TRANSCRIPT_SIDECAR_EXTENSIONS:
            sidecar = transcript_dir / f"transcript{ext}"
            if sidecar.exists() and sidecar.is_file():
                files.append(sidecar)
    return files


def build_cleanup_plan(
    missing_entries: list[tuple[str, str]],
    *,
    catalog_csv: Path,
    normalized_csv: Path | None,
    staging_dir: Path | None,
    transcripts_root: Path,
    potential_mount_issue: bool = False,
    suspect_parent_dirs: list[str] | None = None,
) -> CleanupPlan:
    """Build a cleanup plan for missing catalog entries.

    Args:
        missing_entries: List of (sha256, full_path) tuples for missing files.
        catalog_csv: Path to the catalog CSV.
        normalized_csv: Optional path to the normalized catalog CSV.
        staging_dir: Optional path to the staging directory.
        transcripts_root: Path to the transcripts root directory.
        potential_mount_issue: Whether a mount issue was detected.
        suspect_parent_dirs: List of suspect parent directories.

    Returns:
        CleanupPlan with all targets and statistics.
    """
    targets: list[CleanupTarget] = []

    for sha256, original_path in missing_entries:
        target = CleanupTarget(sha256=sha256, original_path=original_path)

        # Find staged file
        if staging_dir and staging_dir.exists():
            staged = find_staged_file(staging_dir, sha256)
            if staged:
                target.staged_path = staged
                target.staged_exists = True

        # Find transcript directories
        target.transcript_dirs = find_transcript_dirs(transcripts_root, sha256)

        # Find diarization directories
        target.diarization_dirs = find_diarization_dirs(transcripts_root, sha256)

        # Find transcript sidecar files
        target.sidecar_files = find_sidecar_files(target.transcript_dirs)

        targets.append(target)

    plan = CleanupPlan(
        targets=targets,
        catalog_csv=catalog_csv,
        normalized_csv=normalized_csv,
        total_staged=sum(1 for t in targets if t.staged_exists),
        total_transcript_dirs=sum(len(t.transcript_dirs) for t in targets),
        total_diarization_dirs=sum(len(t.diarization_dirs) for t in targets),
        total_sidecar_files=sum(len(t.sidecar_files) for t in targets),
        potential_mount_issue=potential_mount_issue,
        suspect_parent_dirs=suspect_parent_dirs or [],
    )

    return plan


def execute_cleanup(plan: CleanupPlan) -> CleanupResult:
    """Execute the cleanup plan, removing files and directories.

    Args:
        plan: The cleanup plan to execute.

    Returns:
        CleanupResult with statistics and any errors.
    """
    result = CleanupResult()

    for target in plan.targets:
        errors_before = len(result.errors)
        # Remove staged file
        if target.staged_path and target.staged_exists:
            try:
                target.staged_path.unlink()
                result.staged_removed += 1
            except OSError as e:
                result.errors.append(f"Failed to remove staged file {target.staged_path}: {e}")

        # Remove transcript sidecar files first (so counts are accurate)
        for sidecar_file in target.sidecar_files:
            try:
                if sidecar_file.exists():
                    sidecar_file.unlink()
                    result.sidecar_files_removed += 1
            except OSError as e:
                result.errors.append(f"Failed to remove sidecar file {sidecar_file}: {e}")

        # Remove transcript directories
        for transcript_dir in target.transcript_dirs:
            try:
                shutil.rmtree(transcript_dir)
                result.transcript_dirs_removed += 1
            except OSError as e:
                result.errors.append(f"Failed to remove transcript dir {transcript_dir}: {e}")

        # Remove diarization directories
        for diarization_dir in target.diarization_dirs:
            try:
                shutil.rmtree(diarization_dir)
                result.diarization_dirs_removed += 1
            except OSError as e:
                result.errors.append(f"Failed to remove diarization dir {diarization_dir}: {e}")

        if len(result.errors) == errors_before:
            result.hashes_removed += 1
            result.succeeded_hashes.append(target.sha256)
        else:
            result.hashes_failed += 1
            result.failed_hashes.append(target.sha256)

    return result


def infer_staging_dir(normalized_entries: list[tuple[str, str]]) -> Path | None:
    """Infer staging directory from normalized catalog entries.

    Args:
        normalized_entries: List of (sha256, full_path) tuples from normalized catalog.

    Returns:
        Common parent directory if consistent, None otherwise.
    """
    parents: set[Path] = set()

    for _, full_path in normalized_entries:
        if full_path:
            parent = Path(full_path).parent
            if parent.exists():
                parents.add(parent)

    if len(parents) == 1:
        return parents.pop()
    return None
