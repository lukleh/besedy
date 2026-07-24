"""Transcript content/schema validation under the catalog CLI."""

from __future__ import annotations

import argparse
import re
import time
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

from rich.console import Console

from besedy.core.cli_output import print_json_result
from besedy.core.paths import resolve_project_path, resolve_transcripts_root
from besedy.lib.validation.core import (
    batch_validate,
    batch_validate_diarization,
    validate_single_file,
)


def _parse_validation_log(log: str) -> dict:
    """Convert validation stdout into a structured report."""

    lines = [
        line.strip()
        for line in log.splitlines()
        if line.strip() and not re.fullmatch(r"=+", line.strip())
    ]

    summary: dict[str, object] = {}
    steps: list[dict[str, object]] = []

    def add_step(name: str, status: str, count: int | None = None) -> None:
        step: dict[str, object] = {"name": name, "status": status}
        if count is not None:
            step["issues"] = count
        steps.append(step)

    for line in lines:
        if match := re.search(r"^Validating:\s+(.*)$", line):
            summary["target"] = match.group(1)
            add_step("start", "ok")
            continue

        if "Schema validation passed" in line:
            summary["schema_passed"] = True
            add_step("schema", "passed")
            continue

        if match := re.search(r"Segments:\s+(\d+),\s+Words:\s+(\d+)", line):
            summary["segments"] = int(match.group(1))
            summary["words"] = int(match.group(2))
            add_step("counts", "ok")
            continue

        if match := re.search(r"NeMo validation failed \((\d+) issue\(s\)\)", line):
            count = int(match.group(1))
            summary["nemo_validation_passed"] = False
            add_step("backend:nemo", "failed", count)
            continue

        if "NeMo validation passed" in line:
            summary["nemo_validation_passed"] = True
            add_step("backend:nemo", "passed")
            continue

        if line.startswith("✓ All checks passed"):
            summary["status"] = "passed"
            add_step("complete", "passed")
            continue

        if match := re.search(r"Validation failed with (\d+) issue\(s\)", line):
            issues = int(match.group(1))
            summary["status"] = "failed"
            summary["issue_count"] = issues
            add_step("complete", "failed", issues)
            continue

    summary.setdefault("status", "passed" if summary.get("schema_passed") else "unknown")

    return {"summary": summary, "steps": steps}


def _run_validate(
    args: argparse.Namespace, output_format: str
) -> tuple[int, dict[str, object], str]:
    """Run transcript validation against a file or directory."""

    target_path = (
        resolve_transcripts_root()
        if args.input_path is None
        else resolve_project_path(args.input_path)
    )
    json_mode = output_format == "json"
    captured = StringIO() if json_mode else None

    def _validate() -> tuple[int, dict[str, object]]:
        if not target_path.exists():
            msg = f"Error: {target_path} not found"
            if not json_mode:
                print(msg)
            return 1, {
                "mode": "missing",
                "error": "input_not_found",
                "input_path": str(target_path),
                "message": msg,
            }

        if target_path.is_dir():
            transcripts = list(target_path.rglob("transcript.json"))
            total_found = len(transcripts)
            limit = args.limit or total_found
            evaluated = transcripts[:limit]

            if json_mode:
                results: list[dict[str, object]] = []
                group_stats: dict[str, dict[str, int]] = {}
                failures = 0

                for idx, path in enumerate(evaluated, 1):
                    file_buf = StringIO()
                    start = time.perf_counter()
                    with redirect_stdout(file_buf):
                        success = validate_single_file(path, verbose=args.verbose)
                    elapsed_ms = int((time.perf_counter() - start) * 1000)

                    if not success:
                        failures += 1

                    if target_path in path.parents:
                        rel_parts = path.relative_to(target_path).parts
                        group = rel_parts[0] if rel_parts else str(target_path.name)
                    else:
                        group = path.parent.name

                    stats = group_stats.setdefault(group, {"total": 0, "passed": 0, "failed": 0})
                    stats["total"] += 1
                    if success:
                        stats["passed"] += 1
                    else:
                        stats["failed"] += 1

                    results.append(
                        {
                            "index": idx,
                            "path": str(path),
                            "relative_path": str(path.relative_to(target_path)),
                            "group": group,
                            "passed": success,
                            "elapsed_ms": elapsed_ms,
                            "report": _parse_validation_log(file_buf.getvalue()),
                        }
                    )

                data: dict[str, object] = {
                    "mode": "batch",
                    "input_path": str(target_path),
                    "limit": args.limit,
                    "verbose": args.verbose,
                    "files_found": total_found,
                    "files_evaluated": len(evaluated),
                    "files_skipped": max(total_found - len(evaluated), 0),
                    "passed": len(evaluated) - failures,
                    "failed": failures,
                    "results": results,
                    "groups": [
                        {
                            "name": name,
                            "total": stats["total"],
                            "passed": stats["passed"],
                            "failed": stats["failed"],
                        }
                        for name, stats in sorted(group_stats.items())
                    ],
                }
                if getattr(args, "with_diarization", False):
                    silent_console = Console(file=StringIO(), width=80)
                    _, diarization_summary = batch_validate_diarization(
                        target_path,
                        limit=args.limit,
                        verbose=args.verbose,
                        show_progress=False,
                        console=silent_console,
                        quiet=True,
                    )
                    data["diarization"] = diarization_summary
                return 0, data

            console = Console()
            failures = batch_validate(
                target_path,
                limit=args.limit,
                verbose=args.verbose,
                show_progress=not args.verbose,
                console=console,
            )

            diarization_summary = None
            if getattr(args, "with_diarization", False):
                print("\n" + "-" * 70)
                print("Running diarization validation\n")
                _, diarization_summary = batch_validate_diarization(
                    target_path,
                    limit=args.limit,
                    verbose=args.verbose,
                    show_progress=not args.verbose,
                    console=console,
                )

            evaluated_count = total_found if args.limit is None else min(args.limit, total_found)
            passed = max(evaluated_count - failures, 0)
            data = {
                "mode": "batch",
                "input_path": str(target_path),
                "limit": args.limit,
                "verbose": args.verbose,
                "files_found": total_found,
                "files_evaluated": evaluated_count,
                "passed": passed,
                "failed": failures,
            }
            if diarization_summary is not None:
                data["diarization"] = diarization_summary
            return 0, data

        success = validate_single_file(target_path, verbose=args.verbose)
        return 0, {
            "mode": "single",
            "input_path": str(target_path),
            "verbose": args.verbose,
            "passed": success,
        }

    if json_mode:
        assert captured is not None
        with redirect_stdout(captured):
            exit_code, data = _validate()
        log_text = captured.getvalue()
        if log_text:
            data["report"] = _parse_validation_log(log_text)
        return exit_code, data, ""

    exit_code, data = _validate()
    return exit_code, data, ""


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'validate' catalog subparser."""

    parser = subparsers.add_parser(
        "validate",
        help="Validate transcript content/schema (single file or directory)",
        formatter_class=formatter_class,
    )
    parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)",
    )
    parser.add_argument(
        "--input-path",
        type=Path,
        default=None,
        help="Transcript file or directory (default: text_data_dir/transcripts)",
    )
    # Backward-compatible no-op flags used by older docs/scripts.
    parser.add_argument("--batch", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--level",
        choices=["basic", "strict"],
        default="basic",
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--limit", type=int, help="Limit number of files in batch mode")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument(
        "--no-diarization",
        dest="with_diarization",
        action="store_false",
        help="Skip diarization validation (enabled by default)",
    )
    parser.set_defaults(with_diarization=True, func=handle_validate)
    return parser


def handle_validate(args: argparse.Namespace) -> int:
    """Handle catalog validate command."""

    output_format = getattr(args, "format", "text")
    exit_code, data, captured = _run_validate(args, output_format)
    if output_format == "json":
        print_json_result(
            name="validate",
            status="success" if exit_code == 0 else "error",
            result=data,
            output=captured or None,
        )
    return exit_code


__all__ = ["register_parser", "handle_validate", "_parse_validation_log"]
