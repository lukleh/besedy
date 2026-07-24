"""Catalog validation: verify the chain from CSV → staged WAV → transcripts."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from besedy.core.paths import (
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
    iter_transcript_paths,
    parse_transcript_components,
)


@dataclass
class CatalogEntry:
    """Represents a single entry from the audio catalog CSV."""

    sha256: str
    filename: str
    full_path: str
    duration_str: str
    duration_seconds: float


@dataclass
class StagedFile:
    """Represents a staged WAV file."""

    sha256: str
    path: Path
    exists: bool
    size_bytes: int | None = None


@dataclass
class TranscriptSet:
    """Represents transcripts for a single audio hash."""

    sha256: str
    backends: list[
        str
    ]  # e.g., ["canary-nemo/nvidia_canary-1b-v2@...", "faster-whisper/large-v3@..."]
    paths: list[Path]


@dataclass
class DiarizationSet:
    """Represents diarization outputs for a single audio hash."""

    sha256: str
    backends: list[str]  # e.g., ["speaker_diarization/pyannote_speaker-diarization-community-1"]
    paths: list[Path]


@dataclass
class ValidationResult:
    """Results of catalog validation."""

    catalog_entries: int
    normalized_entries: int
    staged_files_found: int
    staged_files_missing: int
    transcripts_found: int
    transcripts_missing: int
    orphaned_staged: int
    orphaned_transcripts: int
    missing_hashes: list[str]
    missing_normalized_hashes: list[str]
    missing_original_hashes: list[tuple[str, str]]  # (hash, path)
    normalized_only_hashes: list[str]
    orphaned_staged_hashes: list[str]
    orphaned_transcript_hashes: list[str]
    entries_with_all_backends: int
    entries_missing_backends: list[tuple[str, list[str]]]  # (hash, missing_backends)
    diarization_found: int
    diarization_missing: int
    orphaned_diarization: int
    missing_diarization_hashes: list[str]
    orphaned_diarization_hashes: list[str]
    entries_with_all_diarization_backends: int
    entries_missing_diarization_backends: list[tuple[str, list[str]]]
    backend_counts: dict[str, int]  # coverage counts per ASR backend (catalog hashes)
    diarization_backend_counts: dict[
        str, int
    ]  # coverage counts per diarization backend (catalog hashes)


def parse_duration(duration_str: str) -> float:
    """Parse duration string from CSV (formats: HH:MM:SS, MM:SS, or seconds).

    Returns duration in seconds.
    """
    duration_str = duration_str.strip()
    if not duration_str:
        return 0.0

    parts = duration_str.split(":")

    try:
        if len(parts) == 3:  # HH:MM:SS
            hours, minutes, seconds = parts
            return float(hours) * 3600 + float(minutes) * 60 + float(seconds)
        elif len(parts) == 2:  # MM:SS
            minutes, seconds = parts
            return float(minutes) * 60 + float(seconds)
        else:  # Assume seconds
            return float(duration_str)
    except (ValueError, TypeError):
        return 0.0


def load_catalog_csv(csv_path: Path) -> list[CatalogEntry]:
    """Load and parse the audio catalog CSV."""
    entries = []

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            sha256 = row.get("Hash", "").strip()
            if not sha256:
                continue

            duration_str = row.get("Duration", "").strip()
            duration_seconds = parse_duration(duration_str)

            entry = CatalogEntry(
                sha256=sha256,
                filename=row.get("Filename", "").strip(),
                full_path=row.get("Full Path", "").strip(),
                duration_str=duration_str,
                duration_seconds=duration_seconds,
            )
            entries.append(entry)

    return entries


def check_staged_files(
    catalog_entries: list[CatalogEntry],
) -> tuple[dict[str, StagedFile], list[str]]:
    """Check which catalog entries have corresponding staged WAV files.

    Uses the ``Full Path`` column from the catalog to locate files.

    Returns:
        - Dictionary mapping hash to StagedFile
        - List of missing hashes
    """
    staged_files: dict[str, StagedFile] = {}
    missing: list[str] = []

    for entry in catalog_entries:
        path_str = entry.full_path.strip()
        if not path_str:
            staged_path = Path()
            exists = False
        else:
            staged_path = Path(path_str)
            exists = staged_path.exists()

        staged = StagedFile(
            sha256=entry.sha256,
            path=staged_path,
            exists=exists,
            size_bytes=staged_path.stat().st_size if exists else None,
        )
        staged_files[entry.sha256] = staged

        if not exists:
            missing.append(entry.sha256)

    return staged_files, missing


def find_orphaned_staged_files(
    staged_dir: Path | None,
    catalog_hashes: set[str],
) -> list[str]:
    """Find staged WAV files that don't appear in the catalog.

    When the directory is unknown or inconsistent across entries, returns [].
    """
    if staged_dir is None or not staged_dir.exists():
        return []

    orphaned: list[str] = []
    for wav_file in staged_dir.glob("*.wav"):
        file_hash = wav_file.stem
        if file_hash not in catalog_hashes:
            orphaned.append(file_hash)

    return orphaned


def discover_backend_directories(transcripts_root: Path) -> set[str]:
    """Discover all backend directories from the transcripts structure.

    Scans for workflow/model directory pairs, even if they contain no transcripts.
    This allows showing "0/N" for backends that exist but have no outputs.

    Returns set of backend keys like "canary-nemo/nvidia_canary-1b-v2@...".
    """
    backends: set[str] = set()

    if not transcripts_root.exists():
        return backends

    from besedy.lib.backend_ids import TRANSCRIPTION_WORKFLOW_IDS

    # Skip known non-workflow directories
    skip_dirs = {PYANNOTE_DIARIZATION_WORKFLOW_LABEL, "speaker_diarization"}
    allowed = set(TRANSCRIPTION_WORKFLOW_IDS)

    for workflow_dir in transcripts_root.iterdir():
        if not workflow_dir.is_dir():
            continue
        if workflow_dir.name in skip_dirs:
            continue
        if workflow_dir.name not in allowed:
            continue
        if workflow_dir.name.startswith("."):
            continue

        # Look for model subdirectories (should contain hash subdirectories)
        for model_dir in workflow_dir.iterdir():
            if not model_dir.is_dir():
                continue
            if model_dir.name.startswith("."):
                continue

            backend_key = f"{workflow_dir.name}/{model_dir.name}"
            backends.add(backend_key)

    return backends


def collect_transcripts_by_hash(
    transcripts_root: Path,
) -> dict[str, TranscriptSet]:
    """Scan transcripts directory and group by audio hash.

    Returns dictionary mapping hash to TranscriptSet.
    """
    transcripts_by_hash: dict[str, TranscriptSet] = {}

    for transcript_path in iter_transcript_paths(transcripts_root):
        components = parse_transcript_components(transcript_path, transcripts_root)
        if not components:
            continue

        workflow, model_component, audio_hash = components
        backend_key = f"{workflow}/{model_component}"

        if audio_hash not in transcripts_by_hash:
            transcripts_by_hash[audio_hash] = TranscriptSet(
                sha256=audio_hash,
                backends=[],
                paths=[],
            )

        transcripts_by_hash[audio_hash].backends.append(backend_key)
        transcripts_by_hash[audio_hash].paths.append(transcript_path)

    return transcripts_by_hash


def collect_diarizations_by_hash(
    transcripts_root: Path,
) -> dict[str, DiarizationSet]:
    """Scan diarization outputs and group by audio hash.

    Expected layout: transcripts_root/speaker_diarization/<model>/<hash>/speakers.json
    """

    diarization_root = transcripts_root / PYANNOTE_DIARIZATION_WORKFLOW_LABEL
    diarization_by_hash: dict[str, DiarizationSet] = {}

    if not diarization_root.exists():
        return diarization_by_hash

    for model_dir in diarization_root.iterdir():
        if not model_dir.is_dir():
            continue

        backend_key = f"{PYANNOTE_DIARIZATION_WORKFLOW_LABEL}/{model_dir.name}"

        # Only consider model dirs that actually contain diarization outputs
        for speakers_path in model_dir.glob("*/speakers.json"):
            audio_hash = speakers_path.parent.name
            if audio_hash not in diarization_by_hash:
                diarization_by_hash[audio_hash] = DiarizationSet(
                    sha256=audio_hash,
                    backends=[],
                    paths=[],
                )

            diarization_by_hash[audio_hash].backends.append(backend_key)
            diarization_by_hash[audio_hash].paths.append(speakers_path)

    return diarization_by_hash


def validate_catalog(
    csv_path: Path,
    csv_normalized_path: Path,
    transcripts_root: Path,
    expected_backends: list[str] | None = None,
    expected_diarization_backends: list[str] | None = None,
) -> ValidationResult:
    """Validate the full chain: catalog CSV → normalized/staged files → transcripts → diarization.

    Args:
        csv_path: Path to audio_catalog.csv (symlink to timestamped source catalog)
        csv_normalized_path: Path to audio_catalog_normalized.csv (symlink to normalized catalog)
        transcripts_root: Path to transcripts directory (usually the transcripts symlink)
        expected_backends: List of expected backend names (e.g., ["canary-nemo/...", "faster-whisper/..."])
        expected_diarization_backends: List of expected diarization backend names

    Returns:
        ValidationResult with detailed statistics
    """
    # Load catalogs
    catalog_entries = load_catalog_csv(csv_path)
    normalized_entries = load_catalog_csv(csv_normalized_path)

    catalog_hashes = {entry.sha256 for entry in catalog_entries}
    normalized_hashes = {entry.sha256 for entry in normalized_entries}
    normalized_lookup = {entry.sha256: entry for entry in normalized_entries}

    # Check staged/normalized WAVs
    staged_records: list[CatalogEntry] = []
    missing_normalized_hashes: list[str] = []
    for entry in catalog_entries:
        normalized_entry = normalized_lookup.get(entry.sha256)
        if normalized_entry is None:
            missing_normalized_hashes.append(entry.sha256)
        else:
            staged_records.append(normalized_entry)

    staged_files, missing_staged = check_staged_files(staged_records)

    # Infer staged directory (if consistent) for orphan detection
    staged_parents = {
        sf.path.parent for sf in staged_files.values() if sf.path and sf.path != Path(".")
    }
    staged_dir = staged_parents.pop() if len(staged_parents) == 1 else None

    # Find orphaned staged files
    orphaned_staged = find_orphaned_staged_files(staged_dir, catalog_hashes)

    # Collect transcripts and diarization
    transcripts_by_hash = collect_transcripts_by_hash(transcripts_root)
    diarization_by_hash = collect_diarizations_by_hash(transcripts_root)

    # Initialize backend_counts from:
    # 1. Expected backends from config (so we show 0/N for backends not yet started)
    # 2. Discovered directories (including empty ones)
    # This ensures we show all known backends, whether configured, discovered, or both
    discovered_backends = discover_backend_directories(transcripts_root)
    all_backends = set(expected_backends or []) | discovered_backends
    backend_counts: dict[str, int] = {backend: 0 for backend in all_backends}

    # Same for diarization backends
    all_diarization_backends = set(expected_diarization_backends or [])
    diarization_backend_counts: dict[str, int] = {
        backend: 0 for backend in all_diarization_backends
    }

    for audio_hash in catalog_hashes:
        if audio_hash in transcripts_by_hash:
            for backend in set(transcripts_by_hash[audio_hash].backends):
                backend_counts[backend] = backend_counts.get(backend, 0) + 1

        if audio_hash in diarization_by_hash:
            for backend in set(diarization_by_hash[audio_hash].backends):
                diarization_backend_counts[backend] = diarization_backend_counts.get(backend, 0) + 1

    # Orphans
    orphaned_transcripts = [h for h in transcripts_by_hash if h not in catalog_hashes]
    orphaned_diarization = [h for h in diarization_by_hash if h not in catalog_hashes]

    # Missing artifacts
    missing_transcripts = [h for h in catalog_hashes if h not in transcripts_by_hash]
    missing_diarization = [h for h in catalog_hashes if h not in diarization_by_hash]

    missing_original_audio: list[tuple[str, str]] = []
    for entry in catalog_entries:
        path_str = entry.full_path.strip()
        if not path_str:
            missing_original_audio.append((entry.sha256, "(no path)"))
            continue
        if not Path(path_str).exists():
            missing_original_audio.append((entry.sha256, path_str))

    # Backend coverage
    entries_with_all_backends = 0
    entries_missing_backends = []
    if expected_backends:
        expected_set = set(expected_backends)
        for audio_hash in catalog_hashes:
            if audio_hash not in transcripts_by_hash:
                entries_missing_backends.append((audio_hash, expected_backends))
                continue
            found_backends = set(transcripts_by_hash[audio_hash].backends)
            missing = sorted(expected_set - found_backends)
            if missing:
                entries_missing_backends.append((audio_hash, missing))
            else:
                entries_with_all_backends += 1

    entries_with_all_diarization_backends = 0
    entries_missing_diarization_backends: list[tuple[str, list[str]]] = []
    if expected_diarization_backends:
        expected_diar_set = set(expected_diarization_backends)
        for audio_hash in catalog_hashes:
            if audio_hash not in diarization_by_hash:
                entries_missing_diarization_backends.append(
                    (audio_hash, expected_diarization_backends)
                )
                continue
            found_backends = set(diarization_by_hash[audio_hash].backends)
            missing = sorted(expected_diar_set - found_backends)
            if missing:
                entries_missing_diarization_backends.append((audio_hash, missing))
            else:
                entries_with_all_diarization_backends += 1

    normalized_only_hashes = sorted(normalized_hashes - catalog_hashes)

    return ValidationResult(
        catalog_entries=len(catalog_entries),
        normalized_entries=len(normalized_entries),
        staged_files_found=len([sf for sf in staged_files.values() if sf.exists]),
        staged_files_missing=len(missing_staged),
        transcripts_found=len([h for h in catalog_hashes if h in transcripts_by_hash]),
        transcripts_missing=len(missing_transcripts),
        orphaned_staged=len(orphaned_staged),
        orphaned_transcripts=len(orphaned_transcripts),
        missing_hashes=missing_staged,
        missing_normalized_hashes=missing_normalized_hashes,
        missing_original_hashes=missing_original_audio,
        normalized_only_hashes=normalized_only_hashes,
        orphaned_staged_hashes=orphaned_staged,
        orphaned_transcript_hashes=orphaned_transcripts,
        entries_with_all_backends=entries_with_all_backends,
        entries_missing_backends=entries_missing_backends,
        diarization_found=len([h for h in catalog_hashes if h in diarization_by_hash]),
        diarization_missing=len(missing_diarization),
        orphaned_diarization=len(orphaned_diarization),
        missing_diarization_hashes=missing_diarization,
        orphaned_diarization_hashes=orphaned_diarization,
        entries_with_all_diarization_backends=entries_with_all_diarization_backends,
        entries_missing_diarization_backends=entries_missing_diarization_backends,
        backend_counts=backend_counts,
        diarization_backend_counts=diarization_backend_counts,
    )


def format_validation_report(result: ValidationResult, verbose: bool = False) -> tuple[str, bool]:
    """Format validation results as a human-readable report.

    Returns:
        Tuple of (report_text, issues_found).
    """
    lines = []

    lines.append("=" * 70)
    lines.append("CATALOG VALIDATION REPORT")
    lines.append("=" * 70)

    # Summary
    lines.append("\n📊 Summary:")
    lines.append(f"  Catalog entries:               {result.catalog_entries}")

    # Visual indicator for normalized catalog entries
    normalized_icon = "✅" if result.catalog_entries == result.normalized_entries else "⚠️"
    lines.append(f"  {normalized_icon} Normalized catalog entries: {result.normalized_entries}")

    # Visual indicators for WAVs
    wav_icon = "✅" if result.staged_files_missing == 0 else "⚠️"
    lines.append(f"  {wav_icon} Normalized WAVs found:      {result.staged_files_found}")
    if result.staged_files_missing > 0:
        lines.append(f"  ❌ Normalized WAVs missing:    {result.staged_files_missing}")

    if result.entries_with_all_backends > 0:
        backend_icon = "✅" if result.entries_with_all_backends == result.catalog_entries else "⚠️"
        lines.append(
            f"  {backend_icon} Entries with all backends:  {result.entries_with_all_backends}"
        )
    if result.entries_with_all_diarization_backends > 0:
        diar_icon = (
            "✅" if result.entries_with_all_diarization_backends == result.catalog_entries else "⚠️"
        )
        lines.append(
            f"  {diar_icon} Entries with all diarization backends: {result.entries_with_all_diarization_backends}"
        )

    if result.backend_counts:
        lines.append("\n🎙️  ASR backends coverage (catalog entries with transcripts):")
        max_backend_len = max(len(backend) for backend in result.backend_counts.keys())
        for backend, count in sorted(result.backend_counts.items()):
            icon = "✅" if count == result.catalog_entries else "⚠️" if count > 0 else "❌"
            lines.append(
                f"    {icon} {backend:<{max_backend_len}}: {count}/{result.catalog_entries}"
            )

    if result.diarization_backend_counts:
        lines.append("\n🗣️  Diarization backends coverage (catalog entries with diarization):")
        max_diar_len = max(len(backend) for backend in result.diarization_backend_counts.keys())
        for backend, count in sorted(result.diarization_backend_counts.items()):
            icon = "✅" if count == result.catalog_entries else "⚠️" if count > 0 else "❌"
            lines.append(f"    {icon} {backend:<{max_diar_len}}: {count}/{result.catalog_entries}")

    # Issues
    issues_found = False

    if result.missing_original_hashes:
        issues_found = True
        lines.append(f"\n⚠️  Missing source audio ({len(result.missing_original_hashes)}):")
        if verbose:
            for h, path in result.missing_original_hashes[:10]:
                lines.append(f"    - {h}  {path}")
            if len(result.missing_original_hashes) > 10:
                lines.append(f"    ... and {len(result.missing_original_hashes) - 10} more")
        else:
            lines.append("    Use --verbose to see list")

    if (
        result.catalog_entries != result.normalized_entries
        or result.normalized_only_hashes
        or result.missing_normalized_hashes
    ):
        issues_found = True
        extra = len(result.normalized_only_hashes)
        missing = len(result.missing_normalized_hashes)
        lines.append(f"\n⚠️  Catalog ↔ normalized mismatch (missing={missing}, extra={extra}):")
        if verbose:
            if result.missing_normalized_hashes:
                lines.append("    Missing in normalized:")
                for h in result.missing_normalized_hashes[:10]:
                    lines.append(f"      - {h}")
                if len(result.missing_normalized_hashes) > 10:
                    lines.append(f"      ... and {len(result.missing_normalized_hashes) - 10} more")
            if result.normalized_only_hashes:
                lines.append("    Extra in normalized:")
                for h in result.normalized_only_hashes[:10]:
                    lines.append(f"      - {h}")
                if len(result.normalized_only_hashes) > 10:
                    lines.append(f"      ... and {len(result.normalized_only_hashes) - 10} more")
        else:
            lines.append("    Use --verbose to see list")

    if result.staged_files_missing > 0:
        issues_found = True
        lines.append(f"\n⚠️  Missing normalized files ({result.staged_files_missing}):")
        if verbose and result.missing_hashes:
            for h in result.missing_hashes[:10]:
                lines.append(f"    - {h}")
            if len(result.missing_hashes) > 10:
                lines.append(f"    ... and {len(result.missing_hashes) - 10} more")
        else:
            lines.append("    Use --verbose to see list")

    if result.transcripts_missing > 0:
        issues_found = True
        lines.append(f"\n⚠️  Missing transcripts ({result.transcripts_missing}):")
        lines.append(f"    {result.transcripts_missing} catalog entries have no transcripts")
        if verbose:
            lines.append("    (These may be in staging or not yet processed)")

    if result.orphaned_staged > 0:
        issues_found = True
        lines.append(f"\n🗑️  Orphaned normalized files ({result.orphaned_staged}):")
        lines.append(f"    {result.orphaned_staged} normalized WAV files not in catalog")
        if verbose and result.orphaned_staged_hashes:
            for h in result.orphaned_staged_hashes[:5]:
                lines.append(f"    - {h}")
            if len(result.orphaned_staged_hashes) > 5:
                lines.append(f"    ... and {len(result.orphaned_staged_hashes) - 5} more")

    if result.orphaned_transcripts > 0:
        issues_found = True
        lines.append(f"\n🗑️  Orphaned transcripts ({result.orphaned_transcripts}):")
        lines.append(f"    {result.orphaned_transcripts} transcript hashes not in catalog")
        if verbose and result.orphaned_transcript_hashes:
            for h in result.orphaned_transcript_hashes[:5]:
                lines.append(f"    - {h}")
            if len(result.orphaned_transcript_hashes) > 5:
                lines.append(f"    ... and {len(result.orphaned_transcript_hashes) - 5} more")

    if result.diarization_missing > 0:
        issues_found = True
        lines.append(f"\n⚠️  Missing diarization ({result.diarization_missing}):")
        lines.append(
            f"    {result.diarization_missing} catalog entries have no diarization outputs"
        )
        if verbose and result.missing_diarization_hashes:
            for h in result.missing_diarization_hashes[:10]:
                lines.append(f"    - {h}")
            if len(result.missing_diarization_hashes) > 10:
                lines.append(f"    ... and {len(result.missing_diarization_hashes) - 10} more")

    if result.orphaned_diarization > 0:
        issues_found = True
        lines.append(f"\n🗑️  Orphaned diarization ({result.orphaned_diarization}):")
        lines.append(f"    {result.orphaned_diarization} diarization hashes not in catalog")
        if verbose and result.orphaned_diarization_hashes:
            for h in result.orphaned_diarization_hashes[:5]:
                lines.append(f"    - {h}")
            if len(result.orphaned_diarization_hashes) > 5:
                lines.append(f"    ... and {len(result.orphaned_diarization_hashes) - 5} more")

    if result.entries_missing_backends:
        issues_found = True
        lines.append(f"\n⚠️  Incomplete backend coverage ({len(result.entries_missing_backends)}):")
        if verbose:
            for h, missing in result.entries_missing_backends[:5]:
                lines.append(f"    - {h}: missing {', '.join(missing)}")
            if len(result.entries_missing_backends) > 5:
                lines.append(f"    ... and {len(result.entries_missing_backends) - 5} more")
        else:
            lines.append("    Use --verbose to see details")

    if result.entries_missing_diarization_backends:
        issues_found = True
        lines.append(
            f"\n⚠️  Incomplete diarization coverage ({len(result.entries_missing_diarization_backends)}):"
        )
        if verbose:
            for h, missing in result.entries_missing_diarization_backends[:5]:
                lines.append(f"    - {h}: missing {', '.join(missing)}")
            if len(result.entries_missing_diarization_backends) > 5:
                lines.append(
                    f"    ... and {len(result.entries_missing_diarization_backends) - 5} more"
                )
        else:
            lines.append("    Use --verbose to see details")

    lines.append("")  # Blank line before separator

    return "\n".join(lines), issues_found
