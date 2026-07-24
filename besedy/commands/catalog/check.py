"""Catalog validation and check command."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from pathlib import Path

from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TaskProgressColumn, TextColumn

from besedy.commands.catalog.csv_utils import resolve_catalog_csv
from besedy.commands.catalog.default_paths import (
    get_default_archived_symlink,
    get_default_catalog_symlink,
    get_default_loudness_symlink,
    get_default_normalized_symlink,
)
from besedy.config.settings import config
from besedy.core.cli_output import print_json_result
from besedy.core.paths import (
    extract_run_id_from_transcripts_root,
    extract_timestamp_from_catalog,
    extract_timestamp_from_normalized_catalog,
    extract_timestamp_from_transcripts_root,
    resolve_transcripts_parent,
    resolve_transcripts_root,
)
from besedy.lib.analysis.coverage import (
    expected_asr_backends_from_code,
    expected_diarization_backends_from_code,
    require_archived_audio,
    require_loudness_catalog,
    require_speaker_clusters,
    require_transcript_exports,
)
from besedy.lib.catalog.validator import (
    format_validation_report,
    load_catalog_csv,
    validate_catalog,
)
from besedy.lib.rag_bundle import resolve_colbert_scope_bundle
from besedy.lib.rag_colbert import resolve_default_colbert_model
from besedy.lib.workflow.config import WorkflowConfig, get_transcription_workflows
from besedy.lib.workflow.paths import sanitize_model_identifier


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'check' subparser."""
    from pathlib import Path

    parser = subparsers.add_parser(
        "check",
        help="Verify pipeline integrity: staged files, transcripts, diarization",
        description="""\
Reports which catalog entries are missing staged audio, transcripts, or
diarization outputs. Useful for identifying incomplete processing.

Example:
  catalog check --verbose              # Show missing files
  catalog check --format json | jq .   # Machine-readable output
""",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--csv",
        type=Path,
        default=None,
        help="Original catalog with source file paths. Default: audio_catalog.csv symlink.",
    )
    parser.add_argument(
        "--csv-normalized",
        type=Path,
        default=None,
        help="Staged catalog (output of stage-audio) with paths to 16kHz mono WAVs. Default: audio_catalog_normalized.csv symlink.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="List individual files that are missing staged audio, transcripts, or diarization.",
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format: text for human reading, json for scripting.",
    )
    parser.set_defaults(func=handle_check)
    return parser


def _rag_backend_key_for_workflow(workflow: WorkflowConfig) -> str:
    model_component = workflow.output_component(sanitize_model_identifier)
    return f"{workflow.workflow_label}/{model_component}"


def _workflow_has_transcripts(transcripts_root: Path, workflow: WorkflowConfig) -> bool:
    backend_key = _rag_backend_key_for_workflow(workflow)
    workflow_dir, model_component = backend_key.split("/", maxsplit=1)
    backend_dir = transcripts_root / workflow_dir / model_component
    if not backend_dir.exists():
        return False
    return any(path.is_file() for path in backend_dir.rglob("transcript.json"))


def require_colbert_bundles(
    transcripts_root: Path,
) -> tuple[bool | None, str | None, dict | None]:
    """Ensure live-search ColBERT bundles exist for transcription backends with transcripts."""

    transcripts_resolved = (
        transcripts_root.resolve() if transcripts_root.is_symlink() else transcripts_root
    )
    run_id = extract_run_id_from_transcripts_root(transcripts_resolved)
    if not run_id:
        return None, "Unable to determine transcript run ID; skipping ColBERT bundle check.", None

    colbert_model = resolve_default_colbert_model()
    candidate_workflows = get_transcription_workflows(expected_only=True)
    expected_backends = [
        _rag_backend_key_for_workflow(workflow)
        for workflow in candidate_workflows
        if _workflow_has_transcripts(transcripts_resolved, workflow)
    ]
    if not expected_backends:
        return (
            None,
            "No transcription backends with transcripts found; skipping ColBERT bundle check.",
            None,
        )

    resolved_backends: list[str] = []
    missing_backends: list[str] = []
    compatibility_errors: list[str] = []
    for backend_key in expected_backends:
        try:
            bundle = resolve_colbert_scope_bundle(
                workflow_group_id=run_id,
                backend_key=backend_key,
                colbert_model=colbert_model,
            )
        except RuntimeError as exc:
            bundle = None
            compatibility_errors.append(f"{backend_key}: {exc}")
        if bundle is None:
            missing_backends.append(backend_key)
        else:
            resolved_backends.append(backend_key)

    stats = {
        "total": len(resolved_backends),
        "expected": len(expected_backends),
        "missing": len(missing_backends),
        "resolved_backends": resolved_backends,
        "missing_backends": missing_backends,
        "compatibility_errors": compatibility_errors,
        "colbert_model": colbert_model,
    }
    if missing_backends:
        suffix = ""
        if compatibility_errors:
            suffix = " | incompatible bundle(s): " + "; ".join(compatibility_errors)
        return (
            False,
            "Missing ColBERT bundle for backend(s): " + ", ".join(missing_backends) + suffix,
            stats,
        )
    return True, None, stats


def handle_check(args: argparse.Namespace) -> int:
    """Validate catalog CSV → staged audio → transcripts → diarization chain."""
    output_format = getattr(args, "format", "text")
    messages: list[str] = []
    command_name = "check"

    def _emit(msg: str) -> None:
        messages.append(msg)
        if output_format == "text":
            print(msg)

    # Resolve catalog path using getter functions when not provided
    try:
        csv_path = resolve_catalog_csv(
            args.csv,
            purpose="check",
            default_symlink=get_default_catalog_symlink(),
        )
    except FileNotFoundError as exc:
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={
                    "error": "catalog_csv_missing",
                    "path": str(args.csv or get_default_catalog_symlink()),
                    "messages": [str(exc)],
                },
            )
        else:
            _emit(str(exc))
        return 1

    if not csv_path.exists():
        if output_format == "json":
            print_json_result(
                name=command_name,
                status="error",
                result={
                    "error": "catalog_csv_missing",
                    "path": str(csv_path),
                    "messages": [f"Catalog CSV not found: {csv_path}"],
                },
            )
        else:
            _emit(f"Catalog CSV not found: {csv_path}")
        return 1

    # Extract timestamp and find matching pipeline files
    ts_catalog = extract_timestamp_from_catalog(csv_path.resolve())
    expected_loudness = None
    expected_archived = None

    if ts_catalog:
        catalog_dir = csv_path.resolve().parent
        normalized_candidates = [
            catalog_dir / f"audio_catalog_{ts_catalog}_loudness_normalized.csv",
            catalog_dir / f"audio_catalog_{ts_catalog}_normalized.csv",
        ]
        expected_normalized = next(
            (candidate for candidate in normalized_candidates if candidate.exists()),
            normalized_candidates[-1],
        )
        transcripts_parent = resolve_transcripts_parent()
        base_name = config.paths.transcripts_dir
        expected_transcripts = transcripts_parent / f"{base_name}_{ts_catalog}"
        expected_loudness = catalog_dir / f"audio_catalog_{ts_catalog}_loudness.csv"
        expected_archived = catalog_dir / f"audio_catalog_{ts_catalog}_loudness_archived.csv"

        if not expected_normalized.exists() or not expected_transcripts.exists():
            # Load catalog to show expected counts
            catalog_entries = load_catalog_csv(csv_path)
            catalog_count = len({entry.sha256 for entry in catalog_entries})

            # Get expected backends from code
            asr_backends = expected_asr_backends_from_code()
            diarization_backends = expected_diarization_backends_from_code()

            # Pipeline incomplete - report gracefully
            incomplete_items: list[str] = []
            _emit(f"\nPipeline incomplete for timestamp {ts_catalog}:")

            if not expected_normalized.exists():
                symlink = args.csv_normalized or get_default_normalized_symlink()
                if symlink.exists():
                    ts_old = extract_timestamp_from_normalized_catalog(symlink.resolve())
                    _emit(f"  Normalized:  not found (symlink → {ts_old})")
                else:
                    _emit("  Normalized:  not found")
                incomplete_items.append("normalized catalog")

            if not expected_transcripts.exists():
                symlink = resolve_transcripts_parent() / config.paths.transcripts_dir
                if symlink.exists():
                    ts_old = extract_timestamp_from_transcripts_root(symlink.resolve())
                    _emit(f"  Transcripts: not found (symlink → {ts_old})")
                else:
                    _emit("  Transcripts: not found")
                incomplete_items.append("transcripts")

            # Check loudness + archive coverage if available
            loudness_ok, loudness_msg, loudness_stats = require_loudness_catalog(
                expected_loudness, {entry.sha256 for entry in catalog_entries}
            )
            archived_ok, archived_msg, archived_stats = require_archived_audio(
                expected_archived, {entry.sha256 for entry in catalog_entries}
            )
            actionable_count = None
            if archived_stats and "expected" in archived_stats and "missing" in archived_stats:
                actionable_count = archived_stats["expected"] - archived_stats["missing"]

            # Show what would be expected for a complete pipeline (matching complete output format)
            _emit(f"\n📊 Catalog: {catalog_count} audio files")

            # Loudness catalog
            _emit("\n📈 Loudness catalog:")
            if loudness_stats:
                issue_parts = []
                if loudness_stats.get("missing", 0) > 0:
                    issue_parts.append(f"missing {loudness_stats['missing']}")
                if loudness_stats.get("stale", 0) > 0:
                    issue_parts.append(f"+{loudness_stats['stale']} stale")
                if loudness_stats.get("missing_metrics", 0) > 0:
                    issue_parts.append(f"missing metrics {loudness_stats['missing_metrics']}")
                issue_info = f" ({', '.join(issue_parts)})" if issue_parts else ""
                status = "✅" if loudness_ok else "⚠️"
                _emit(
                    f"    {status} loudness: {loudness_stats.get('total', 0)}/{catalog_count}{issue_info}"
                )
            elif not loudness_ok:
                _emit(f"    ❌ {loudness_msg}")
            else:
                _emit("    ✅ OK")

            # Archived audio
            _emit("\n📦 Archived audio:")
            if archived_stats:
                issue_parts = []
                if archived_stats.get("missing", 0) > 0:
                    issue_parts.append(f"missing {archived_stats['missing']}")
                if archived_stats.get("stale", 0) > 0:
                    issue_parts.append(f"+{archived_stats['stale']} stale")
                if archived_stats.get("missing_paths", 0) > 0:
                    issue_parts.append(f"missing paths {archived_stats['missing_paths']}")
                if archived_stats.get("missing_files", 0) > 0:
                    issue_parts.append(f"missing files {archived_stats['missing_files']}")
                issue_info = f" ({', '.join(issue_parts)})" if issue_parts else ""
                status = "✅" if archived_ok else "⚠️"
                _emit(
                    f"    {status} archived: {archived_stats.get('total', 0)}/{catalog_count}{issue_info}"
                )
            elif not archived_ok:
                _emit(f"    ❌ {archived_msg}")
            else:
                _emit("    ✅ OK")

            # Archived coverage (archived catalog only)
            if actionable_count is not None:
                actionable_status = "✅" if actionable_count == catalog_count else "⚠️"
                _emit(
                    f"\n✅ Archived coverage (archived catalog): {actionable_count}/{catalog_count}"
                    if actionable_status == "✅"
                    else f"\n⚠️  Archived coverage (archived catalog): {actionable_count}/{catalog_count}"
                )

            # Transcription backends (format: icon backend: current/expected)
            _emit("\n📝 Transcription backends coverage:")
            max_asr_len = max(len(b) for b in asr_backends) if asr_backends else 0
            for backend in asr_backends:
                _emit(f"    ❌ {backend:<{max_asr_len}}: 0/{catalog_count}")

            # Diarization backends
            _emit("\n🗣️  Diarization backends coverage:")
            max_diar_len = max(len(b) for b in diarization_backends) if diarization_backends else 0
            for backend in diarization_backends:
                _emit(f"    ❌ {backend:<{max_diar_len}}: 0/{catalog_count}")

            # Derived artifacts
            _emit("\n📄 Transcript exports:")
            for backend in asr_backends:
                _emit(f"    ❌ {backend:<{max_asr_len}}: 0/{catalog_count}")

            _emit("\n👥 Speaker clusters:")
            for backend in diarization_backends:
                _emit(f"    ❌ {backend:<{max_diar_len}}: 0/{catalog_count}")

            _emit("\nRun the pipeline to generate these files.")

            if output_format == "json":
                print_json_result(
                    name=command_name,
                    status="warning",
                    result={
                        "timestamp": ts_catalog,
                        "missing": incomplete_items,
                        "pipeline_artifacts": {
                            "loudness": {
                                "ok": loudness_ok,
                                "message": loudness_msg,
                                "stats": loudness_stats,
                            },
                            "archived": {
                                "ok": archived_ok,
                                "message": archived_msg,
                                "stats": archived_stats,
                            },
                            "actionable": {
                                "count": actionable_count,
                                "expected": catalog_count,
                            },
                        },
                        "messages": messages,
                    },
                )
            return 0  # Not an error, just incomplete

        csv_normalized_path = expected_normalized
        transcripts_root = expected_transcripts
    else:
        # No timestamp in catalog name - fall back to symlink resolution
        normalized_symlink = args.csv_normalized or get_default_normalized_symlink()
        csv_normalized_path = (
            normalized_symlink.resolve() if normalized_symlink.exists() else normalized_symlink
        )
        transcripts_root = resolve_transcripts_root()
        expected_loudness = get_default_loudness_symlink()
        expected_archived = get_default_archived_symlink()

        if not csv_normalized_path.exists():
            if output_format == "json":
                print_json_result(
                    name=command_name,
                    status="error",
                    result={
                        "error": "normalized_csv_missing",
                        "path": str(csv_normalized_path),
                        "messages": [f"Normalized catalog CSV not found: {csv_normalized_path}"],
                    },
                )
            else:
                _emit(f"Normalized catalog CSV not found: {csv_normalized_path}")
            return 1
        if not transcripts_root.exists():
            if output_format == "json":
                print_json_result(
                    name=command_name,
                    status="error",
                    result={
                        "error": "transcripts_root_missing",
                        "path": str(transcripts_root),
                        "messages": [f"Transcripts root not found: {transcripts_root}"],
                    },
                )
            else:
                _emit(f"Transcripts root not found: {transcripts_root}")
            return 1

    console = Console()
    use_progress = output_format == "text"

    # Define verification steps
    steps = [
        ("Loading catalog", "catalog"),
        ("Checking loudness catalog", "loudness"),
        ("Checking archived audio", "archived"),
        ("Checking transcript export coverage", "txt"),
        ("Checking ColBERT bundles", "colbert"),
        ("Checking speaker clusters", "clusters"),
        ("Validating catalog chain", "validate"),
    ]

    # Initialize results
    catalog_entries = None
    catalog_hashes: set[str] = set()
    catalog_count = 0
    pipeline_artifacts_status: list[tuple[str, bool | None, str | None, dict | None]] = []
    derived_dirs_status: list[tuple[str, bool | None, str | None, dict | None]] = []
    loudness_ok, loudness_msg, loudness_stats = False, None, None
    archived_ok, archived_msg, archived_stats = False, None, None
    exports_ok, exports_msg, exports_stats = False, None, None
    clusters_ok, clusters_msg, clusters_stats = False, None, None
    expected_backends = None
    diarization_backends = None
    result = None
    actionable_count = None

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
        console=console,
        transient=True,
        disable=not use_progress,
    ) as progress:
        task = progress.add_task("Verifying...", total=len(steps))

        for step_name, step_id in steps:
            progress.update(task, description=step_name)

            match step_id:
                case "catalog":
                    catalog_entries = load_catalog_csv(csv_path)
                    catalog_hashes = {entry.sha256 for entry in catalog_entries}
                    catalog_count = len(catalog_hashes)

                case "loudness":
                    loudness_ok, loudness_msg, loudness_stats = require_loudness_catalog(
                        expected_loudness, catalog_hashes
                    )
                    pipeline_artifacts_status.append(
                        ("loudness_catalog", loudness_ok, loudness_msg, loudness_stats)
                    )

                case "archived":
                    archived_ok, archived_msg, archived_stats = require_archived_audio(
                        expected_archived, catalog_hashes
                    )
                    pipeline_artifacts_status.append(
                        ("archived_audio", archived_ok, archived_msg, archived_stats)
                    )

                case "txt":
                    exports_ok, exports_msg, exports_stats = require_transcript_exports(
                        transcripts_root, catalog_hashes
                    )
                    derived_dirs_status.append(
                        ("transcript_exports", exports_ok, exports_msg, exports_stats)
                    )

                case "colbert":
                    colbert_ok, colbert_msg, colbert_stats = require_colbert_bundles(
                        transcripts_root
                    )
                    pipeline_artifacts_status.append(
                        ("colbert_bundle", colbert_ok, colbert_msg, colbert_stats)
                    )

                case "clusters":
                    # Speaker clusters directory is a sibling to transcripts with matching run_id
                    transcripts_resolved = (
                        transcripts_root.resolve()
                        if transcripts_root.is_symlink()
                        else transcripts_root
                    )
                    run_id = extract_run_id_from_transcripts_root(transcripts_resolved)
                    if run_id:
                        clusters_root = transcripts_root.parent / f"speaker_clusters_{run_id}"
                    else:
                        clusters_root = transcripts_root.parent / config.paths.speaker_clusters_dir
                    clusters_ok, clusters_msg, clusters_stats = require_speaker_clusters(
                        transcripts_root, clusters_root, catalog_hashes
                    )
                    derived_dirs_status.append(
                        ("speaker_clusters", clusters_ok, clusters_msg, clusters_stats)
                    )

                case "validate":
                    expected_backends = expected_asr_backends_from_code()
                    if not expected_backends:
                        _emit(
                            "Warning: unable to determine ASR backends from code; skipping backend coverage check."
                        )
                        expected_backends = None

                    diarization_backends = expected_diarization_backends_from_code()
                    if not diarization_backends:
                        _emit(
                            "Warning: unable to determine diarization backends from code; skipping diarization backend coverage check."
                        )
                        diarization_backends = None

                    result = validate_catalog(
                        csv_path,
                        csv_normalized_path,
                        transcripts_root,
                        expected_backends=expected_backends,
                        expected_diarization_backends=diarization_backends,
                    )

            progress.advance(task)

    if result is None:
        raise RuntimeError("Catalog validation did not produce a result.")

    report_text, catalog_issues_found = format_validation_report(result, verbose=args.verbose)

    if archived_stats and "expected" in archived_stats and "missing" in archived_stats:
        actionable_count = archived_stats["expected"] - archived_stats["missing"]

    # Core pipeline issues (data integrity problems, not pending work)
    # Note: missing_normalized_hashes is NOT an error - it just means files
    # are in the catalog but not yet staged (normal intermediate state)
    core_issues_detected = any(
        [
            result.missing_original_hashes,  # normalized references non-existent catalog entries
            result.normalized_only_hashes,  # normalized has entries not in catalog
            result.staged_files_missing,  # normalized references missing WAV files
            result.orphaned_staged,  # staged files with no catalog entry
            result.orphaned_transcripts,  # transcripts with no catalog entry
            result.orphaned_diarization,  # diarization with no catalog entry
        ]
    )

    # Derived artifacts issues (transcript exports, clusters) - warnings, not failures
    derived_issues_detected = any(ok is False for _, ok, _, _ in derived_dirs_status)
    pipeline_artifacts_issues_detected = any(
        ok is False for _, ok, _, _ in pipeline_artifacts_status
    )

    has_stale_files = False
    for name, _, _, stats in derived_dirs_status:
        if stats:
            for s in stats.values():
                if isinstance(s, dict) and s.get("stale", 0) > 0:
                    has_stale_files = True
                    break

    if output_format == "text":
        print(report_text)

        # Emit pipeline artifact status (loudness + archive)
        if pipeline_artifacts_status:
            for name, ok, msg, stats in pipeline_artifacts_status:
                emoji = {
                    "loudness_catalog": "📈",
                    "archived_audio": "📦",
                    "colbert_bundle": "🔎",
                }.get(name, "📁")
                display_name = name.replace("_", " ").title()
                if name == "loudness_catalog":
                    display_name = "Loudness catalog"
                elif name == "archived_audio":
                    display_name = "Archived audio"
                elif name == "colbert_bundle":
                    display_name = "ColBERT bundle"
                print(f"{emoji}  {display_name}:")

                if stats:
                    issue_parts = []
                    if stats.get("missing", 0) > 0:
                        issue_parts.append(f"missing {stats['missing']}")
                    if stats.get("stale", 0) > 0:
                        issue_parts.append(f"+{stats['stale']} stale")
                    if stats.get("missing_metrics", 0) > 0:
                        issue_parts.append(f"missing metrics {stats['missing_metrics']}")
                    if stats.get("missing_paths", 0) > 0:
                        issue_parts.append(f"missing paths {stats['missing_paths']}")
                    if stats.get("missing_files", 0) > 0:
                        issue_parts.append(f"missing files {stats['missing_files']}")
                    issue_info = f" ({', '.join(issue_parts)})" if issue_parts else ""
                    status = "✅" if ok else "⚠️"
                    total = stats.get("total", 0)
                    expected = stats.get("expected", catalog_count)
                    print(f"    {status} {total}/{expected}{issue_info}")
                elif ok is False:
                    print(f"    ❌ {msg}")
                elif ok is None:
                    print(f"    ℹ️  {msg}")
                else:
                    print("    ✅ OK")
                print()

            # Archived coverage (archived catalog only)
            if actionable_count is not None:
                actionable_status = "✅" if actionable_count == catalog_count else "⚠️"
                print(
                    f"{actionable_status} Archived coverage (archived catalog): {actionable_count}/{catalog_count}"
                )
                print()

        # Emit derived directories status after catalog report
        for name, ok, msg, stats in derived_dirs_status:
            # Section header with emoji
            emoji = {
                "transcript_exports": "📄",
                "speaker_clusters": "👥",
            }.get(name, "📁")
            # Clean up display names
            display_name = name.replace("_", " ").title()
            if name == "transcript_exports":
                display_name = "Transcript exports"
            elif name == "speaker_clusters":
                display_name = "Speaker clusters"
            print(f"{emoji}  {display_name}:")

            if stats:
                # Calculate max backend name length for alignment
                max_len = max(len(b) for b in stats.keys())
                for backend, s in stats.items():
                    padded_name = backend.ljust(max_len)
                    if isinstance(s, dict):
                        total = s.get("total")
                        expected = s.get("expected")
                        missing = s.get("missing")
                        stale = s.get("stale")
                        if missing is None and total is not None and expected is not None:
                            missing = max(0, expected - total)
                        is_ok = (
                            missing == 0
                            and (stale or 0) == 0
                            and total is not None
                            and expected is not None
                            and total == expected
                        )
                        status = "✅" if is_ok else "⚠️"
                        if missing is None and (total is None or expected is None):
                            issue_info = " (stats incomplete)"
                        elif missing and missing > 0:
                            issue_info = f" (missing {missing})"
                        elif stale and stale > 0:
                            issue_info = f" (+{stale} stale)"
                        elif total is not None and expected is not None and total > expected:
                            issue_info = f" (+{total - expected} stale)"
                        else:
                            issue_info = ""
                        total_display = total if total is not None else 0
                        expected_display = expected if expected is not None else catalog_count
                    else:
                        status = "⚠️"
                        issue_info = " (stats invalid)"
                        total_display = 0
                        expected_display = catalog_count
                    print(
                        f"    {status} {padded_name}: {total_display}/{expected_display}{issue_info}"
                    )
            elif ok is False:
                print(f"    ⚠️  {msg}")
            elif ok is None:
                print(f"    ℹ️  {msg}")
            else:
                print("    ✅ OK")
            print()

        # Final status at the end
        if (
            not core_issues_detected
            and not derived_issues_detected
            and not pipeline_artifacts_issues_detected
            and not has_stale_files
        ):
            print("✅ All checks passed!")
        elif (
            not core_issues_detected
            and not derived_issues_detected
            and not pipeline_artifacts_issues_detected
            and has_stale_files
        ):
            print("⚠️  Pipeline OK, but stale files detected")
            print("    Run: just catalog clean --prune-orphans  # Remove stale derived files")
        elif not core_issues_detected and (
            derived_issues_detected or pipeline_artifacts_issues_detected
        ):
            print("⚠️  Core pipeline OK, but artifacts need regeneration")
            if pipeline_artifacts_issues_detected:
                if not loudness_ok:
                    print("    Run: just catalog loudness  # Generate loudness catalog")
                if not archived_ok:
                    print("    Run: just catalog archive   # Generate archived audio")
                if any(
                    name == "colbert_bundle" and ok is False
                    for name, ok, _, _ in pipeline_artifacts_status
                ):
                    print(
                        "    Run: just catalog rag-colbert-index  # Build/update ColBERT sidecar bundles"
                    )
            # Show specific commands for failed checks
            failed_artifacts = [
                (name, msg) for name, ok, msg, _ in derived_dirs_status if ok is False
            ]
            for name, msg in failed_artifacts:
                if name == "transcript_exports":
                    print(
                        "    Run: just catalog export-transcripts  # Regenerate transcript sidecars"
                    )
                elif name == "speaker_clusters":
                    print(f"    Run: just catalog cluster-speakers  # {msg}")
            if has_stale_files:
                print("    Run: just catalog clean --prune-orphans  # Remove stale derived files")
        elif core_issues_detected:
            print("❌ Core pipeline issues detected (see above)")
        print()
        print("=" * 70)

    if output_format == "json":
        data = {
            "result": asdict(result),
            "core_issues_detected": core_issues_detected,
            "derived_issues_detected": derived_issues_detected,
            "pipeline_artifacts_issues_detected": pipeline_artifacts_issues_detected,
            "derived_directories": {
                name: {"ok": ok, "message": msg, "stats": stats}
                for name, ok, msg, stats in derived_dirs_status
            },
            "pipeline_artifacts": {
                name: {"ok": ok, "message": msg, "stats": stats}
                for name, ok, msg, stats in pipeline_artifacts_status
            },
            "actionable_coverage": {
                "count": actionable_count,
                "expected": catalog_count,
            },
            "archived_coverage": {
                "count": actionable_count,
                "expected": catalog_count,
            },
            "expected_backends_checked": bool(expected_backends),
            "expected_diarization_backends_checked": bool(diarization_backends),
            "messages": messages,
            "verbose": args.verbose,
            "csv": str(csv_path),
            "csv_normalized": str(csv_normalized_path),
            "transcripts_root": str(transcripts_root),
        }
        if expected_backends:
            data["expected_backends"] = expected_backends
        if diarization_backends:
            data["expected_diarization_backends"] = diarization_backends
        status = "success" if not core_issues_detected else "error"
        if not core_issues_detected and (
            derived_issues_detected or pipeline_artifacts_issues_detected
        ):
            status = "warning"
        print_json_result(name=command_name, status=status, result=data)

    # Only fail on core pipeline issues, not derived artifacts
    return 1 if core_issues_detected else 0
