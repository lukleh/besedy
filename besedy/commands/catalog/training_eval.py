"""Score ASR models on a training dataset's held-out recordings (ADR 0012)."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from besedy.core.paths import PROJECT_ROOT
from besedy.core.symlinks import create_or_update_symlink
from besedy.lib import asr_evaluation as ev
from besedy.lib.runtime.backend_runtime import (
    build_python_backend_process,
    forward_host_env,
    resolve_local_model_path,
)
from besedy.lib.workflow.paths import sanitize_model_identifier

EVAL_SCRIPT_PATH = PROJECT_ROOT / "besedy" / "workflows" / "eval_faster_whisper.py"
MACHINE_LABEL = "machine"


def register_parser(
    subparsers: argparse._SubParsersAction,  # type: ignore[type-arg]
    formatter_class: type[argparse.HelpFormatter],
) -> argparse.ArgumentParser:
    """Register the 'training-eval' subparser."""
    parser = subparsers.add_parser(
        "training-eval",
        help="Score a CTranslate2 model on a training dataset's test recordings",
        description="""\
Scores a model on the chunks of a dataset built by training-export, through the
production decode path: the faster-whisper image, BatchedInferencePipeline and
the options transcribe_faster_whisper.py uses. The corrected text is the
reference. Every report carries raw and normalized word error rate and
normalized character error rate (lowercase, punctuation removed, diacritics
and digits kept), the model's identity (path, model.bin hash), the decode
options, the dataset and the git commit, plus the machine-text baseline: the
production transcript the correctors started from, read from the manifest.

Without --model only that baseline is computed, on this host, with no Docker.
With --compare, saved reports scored on identical rows are printed as one table.

The report goes to <dataset>/eval/<label>_<timestamp>/ (report.json and
hypotheses.jsonl, worst chunks first) with an <dataset>/eval/<label> symlink.

Examples:
  catalog training-eval --data training_export --model large-v3
  catalog training-eval --data training_export --model ~/whisper_models/besedy-ct2 --label finetuned
  catalog training-eval --data training_export
  catalog training-eval --compare training_export/eval/large-v3/report.json \\
      training_export/eval/finetuned/report.json
""",
        formatter_class=formatter_class,
    )
    parser.add_argument("--data", type=Path, help="Dataset directory (manifest.jsonl, audio/)")
    parser.add_argument("--model", help="CTranslate2 model directory or faster-whisper alias")
    parser.add_argument("--label", help="Name of the system in the report (default: the model)")
    parser.add_argument("--split", default="test", help="Which split to score")
    parser.add_argument(
        "--recordings",
        type=Path,
        help="Score only these audio hashes (JSON list, {audio_hashes: [...]} or one per line)",
    )
    parser.add_argument("--out", type=Path, help="Report directory (default: under the dataset)")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--language", help="Inference language (default: the configured one)")
    parser.add_argument(
        "--compare",
        nargs="+",
        type=Path,
        metavar="REPORT",
        help="Print one table over these report.json files instead of scoring",
    )
    parser.set_defaults(func=handle_training_eval)
    return parser


def git_commit() -> str | None:
    """The checkout's commit, with -dirty when it has uncommitted changes; None without git."""
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, capture_output=True, text=True
        )
        status = subprocess.run(
            ["git", "status", "--porcelain"], cwd=PROJECT_ROOT, capture_output=True, text=True
        )
    except OSError:
        return None
    if head.returncode != 0:
        return None
    commit = head.stdout.strip()
    return f"{commit}-dirty" if status.stdout.strip() else commit


def report_dir(data_dir: Path, label: str) -> tuple[Path, Path]:
    """A timestamped report directory under the dataset and the symlink to point at it."""
    base = data_dir / "eval"
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return base / f"{label}_{stamp}", base / label


def machine_baseline_report(args: argparse.Namespace, out: Path) -> int:
    recordings = ev.load_recordings(args.recordings) if args.recordings else None
    rows = ev.select_rows(ev.load_manifest(args.data), args.split, recordings)
    if not rows:
        raise ValueError(f"No {args.split} rows in {args.data / 'manifest.jsonl'}")
    report = ev.build_report(
        system=ev.MACHINE_SYSTEM,
        dataset=ev.dataset_identity(args.data),
        split=args.split,
        rows=rows,
        scores=None,
        model=None,
        options=None,
        git_commit=git_commit(),
        recordings_source=str(args.recordings) if args.recordings else None,
    )
    if report["machine_baseline"] is None:
        raise ValueError(
            "The manifest carries no machine_text; export the dataset again with the current code"
        )
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    with_machine = [row for row in rows if row.get("machine_text") is not None]
    ev.write_hypotheses(
        out / "hypotheses.jsonl",
        ev.score_rows(with_machine, [str(row["machine_text"]) for row in with_machine]),
    )
    print(ev.comparison_table([report]))
    print(f"Report: {out / 'report.json'}")
    return 0


def model_report(args: argparse.Namespace, out: Path, label: str) -> int:
    # A local directory goes in by its absolute path: the worker resolves
    # relative paths against its own working directory, not this one.
    local_model = resolve_local_model_path(args.model)
    script_args = [
        "--data",
        str(args.data),
        "--out",
        str(out),
        "--model",
        str(local_model) if local_model is not None else args.model,
        "--label",
        label,
        "--split",
        args.split,
        "--device",
        args.device,
        "--compute-type",
        args.compute_type,
        "--batch-size",
        str(args.batch_size),
    ]
    input_paths: list[Path | str] = [args.data]
    if args.recordings is not None:
        script_args.extend(["--recordings", str(args.recordings)])
        input_paths.append(args.recordings)
    if args.language is not None:
        script_args.extend(["--language", args.language])
    commit = git_commit()
    if commit is not None:
        script_args.extend(["--git-commit", commit])
    out.mkdir(parents=True, exist_ok=True)
    process = build_python_backend_process(
        backend_id="faster-whisper",
        display_name="faster-whisper",
        script_path=EVAL_SCRIPT_PATH,
        script_args=script_args,
        docker_service="faster-whisper",
        extra_env=forward_host_env("HF_TOKEN") or None,
        input_paths=input_paths,
        output_paths=[out],
        model_paths=[local_model] if local_model is not None else None,
        docker_gpus="all",
    )
    env = os.environ.copy()
    if process.extra_env:
        env.update(process.extra_env)
    result = subprocess.run(process.argv, env=env, cwd=str(PROJECT_ROOT), check=False)
    if result.returncode != 0 and not any(out.iterdir()):
        out.rmdir()  # the mount point was made for the worker; a failed run leaves nothing
    return result.returncode


def handle_training_eval(args: argparse.Namespace) -> int:
    try:
        if args.compare:
            reports = [json.loads(path.read_text(encoding="utf-8")) for path in args.compare]
            print(ev.comparison_table(reports))
            return 0
        if args.data is None:
            raise ValueError("--data is required unless --compare is given")
        args.data = args.data.expanduser().resolve()
        if args.recordings is not None:
            args.recordings = args.recordings.expanduser().resolve()
        label = args.label or (
            sanitize_model_identifier(args.model) if args.model else MACHINE_LABEL
        )
        if args.out is not None:
            out, symlink = args.out.expanduser().resolve(), None
        else:
            out, symlink = report_dir(args.data, label)
        if args.model is None:
            code = machine_baseline_report(args, out)
        else:
            code = model_report(args, out, label)
        if code == 0 and symlink is not None:
            create_or_update_symlink(symlink, out, description="evaluation report")
        return code
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
