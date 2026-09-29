#!/usr/bin/env python3
"""Rename Czech transcript variants to their explicit ``@lang-cs`` identity.

Pass timestamped transcript roots, not the ``transcripts`` symlink or a merged
transcript tree. The default is a read-only plan; ``--apply`` renames directories
in place. Optional merged roots update derived ``slots.json`` model labels.
Re-running after an interrupted apply completes the remaining changes.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

from besedy.lib.data.atomic_io import atomic_path

DEFAULT_WORKFLOW_LABELS = ("canary-nemo", "faster-whisper", "whisperx", "qwen3-asr")
MODEL_FIELD_RE = re.compile(r'("model"\s*:\s*")([^"\\]+)(")')
QUOTED_VALUE_RE = re.compile(r'"([^"\\]+)"')
MODELS_OPEN_RE = re.compile(r'"models"\s*:\s*\[')


def plan_moves(
    roots: list[Path], workflow_labels: set[str], *, rollback: bool = False
) -> list[tuple[Path, Path]]:
    """Preflight every old and new variant before changing any directory."""
    moves: list[tuple[Path, Path]] = []
    seen_roots: set[Path] = set()
    for root in roots:
        if (
            not root.is_dir()
            or root.is_symlink()
            or not re.fullmatch(r"transcripts_\d{8}_\d{6}", root.name)
        ):
            raise ValueError(f"Expected a timestamped transcript directory, not {root}")
        if root.resolve() in seen_roots:
            continue
        seen_roots.add(root.resolve())
        for label in sorted(workflow_labels):
            workflow_dir = root / label
            if not workflow_dir.exists():
                continue
            if not workflow_dir.is_dir() or workflow_dir.is_symlink():
                raise ValueError(f"Expected a workflow directory, not {workflow_dir}")
            for variant in sorted(workflow_dir.iterdir()):
                if variant.name.endswith("@lang-cs"):
                    old = variant.with_name(variant.name[: -len("@lang-cs")])
                    if old.exists() or old.is_symlink():
                        raise ValueError(f"Both Czech variant paths exist: {old} and {variant}")
                    if rollback:
                        if not variant.is_dir() or variant.is_symlink():
                            raise ValueError(f"Expected a transcript variant directory, not {variant}")
                        moves.append((variant, old))
                    continue
                if "@lang-" in variant.name:
                    continue
                if variant.is_symlink():
                    raise ValueError(f"Expected a transcript variant directory, not {variant}")
                if not variant.is_dir():
                    continue
                target = variant.with_name(f"{variant.name}@lang-cs")
                if target.exists() or target.is_symlink():
                    raise ValueError(f"Both Czech variant paths exist: {variant} and {target}")
                if not rollback:
                    moves.append((variant, target))
    return moves


def _rewrite_model_key(value: str, workflow_labels: set[str], *, rollback: bool) -> str:
    label, separator, component = value.partition("/")
    if not separator or label not in workflow_labels:
        return value
    if rollback:
        return f"{label}/{component[: -len('@lang-cs')]}" if component.endswith("@lang-cs") else value
    return value if "@lang-" in component else f"{value}@lang-cs"


def _models_array_end(text: str) -> int | None:
    """Find the closing bracket outside JSON strings (model names can contain ``]``)."""
    in_string = False
    escaped = False
    for index, character in enumerate(text):
        if escaped:
            escaped = False
        elif character == "\\" and in_string:
            escaped = True
        elif character == '"':
            in_string = not in_string
        elif character == "]" and not in_string:
            return index
    return None


def _rewrite_slot_line(
    line: str, workflow_labels: set[str], *, rollback: bool, in_models: bool
) -> tuple[str, bool]:
    open_match = None if in_models else MODELS_OPEN_RE.search(line)
    if open_match:
        prefix = line[: open_match.end()]
        remaining = line[open_match.end() :]
        in_models = True
    else:
        prefix = ""
        remaining = line

    if in_models:
        close_index = _models_array_end(remaining)
        models_text = remaining if close_index is None else remaining[:close_index]
        models_text = QUOTED_VALUE_RE.sub(
            lambda match: f'"{_rewrite_model_key(match.group(1), workflow_labels, rollback=rollback)}"',
            models_text,
        )
        if close_index is None:
            return prefix + models_text, True
        remaining = prefix + models_text + remaining[close_index:]

    rewritten = MODEL_FIELD_RE.sub(
        lambda match: (
            match.group(1)
            + _rewrite_model_key(match.group(2), workflow_labels, rollback=rollback)
            + match.group(3)
        ),
        remaining,
    )
    return rewritten, False


def _iter_rewritten_slot_lines(path: Path, workflow_labels: set[str], *, rollback: bool):
    in_models = False
    with path.open("r", encoding="utf-8", newline="") as stream:
        for line in stream:
            rewritten, in_models = _rewrite_slot_line(
                line, workflow_labels, rollback=rollback, in_models=in_models
            )
            yield line, rewritten


def plan_merged_slot_rewrites(
    roots: list[Path], workflow_labels: set[str], *, rollback: bool = False
) -> list[Path]:
    """Find derived slot files whose model labels need a streaming rewrite."""
    rewrites: list[Path] = []
    seen_roots: set[Path] = set()
    for root in roots:
        if (
            not root.is_dir()
            or root.is_symlink()
            or not re.fullmatch(r"transcripts_merged_\d{8}_\d{6}", root.name)
        ):
            raise ValueError(f"Expected a timestamped merged-transcripts directory, not {root}")
        if root.resolve() in seen_roots:
            continue
        seen_roots.add(root.resolve())
        for path in sorted(root.glob("*/slots.json")):
            if not path.is_file() or path.is_symlink():
                raise ValueError(f"Expected a regular slots.json file, not {path}")
            if any(
                original != rewritten
                for original, rewritten in _iter_rewritten_slot_lines(
                    path, workflow_labels, rollback=rollback
                )
            ):
                rewrites.append(path)
    return rewrites


def rewrite_merged_slots(path: Path, workflow_labels: set[str], *, rollback: bool = False) -> None:
    """Atomically change only model-key lines, leaving all other bytes intact."""
    with atomic_path(path, follow_symlinks=False) as temporary:
        with temporary.open("w", encoding="utf-8", newline="") as output:
            for _, rewritten in _iter_rewritten_slot_lines(
                path, workflow_labels, rollback=rollback
            ):
                output.write(rewritten)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path, help="Timestamped transcript roots")
    parser.add_argument(
        "--workflow-label",
        action="append",
        default=[],
        help="Additional transcription workflow label to migrate",
    )
    parser.add_argument(
        "--merged-root",
        action="append",
        default=[],
        type=Path,
        help="Timestamped merged-transcripts root whose slots.json labels should be updated",
    )
    parser.add_argument("--apply", action="store_true", help="Rename the planned directories")
    parser.add_argument("--rollback", action="store_true", help="Rename @lang-cs variants back")
    args = parser.parse_args()

    try:
        workflow_labels = set(DEFAULT_WORKFLOW_LABELS) | set(args.workflow_label)
        moves = plan_moves(
            args.roots,
            workflow_labels,
            rollback=args.rollback,
        )
        rewrites = plan_merged_slot_rewrites(
            args.merged_root, workflow_labels, rollback=args.rollback
        )
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Migration preflight failed: {exc}\n")

    for old, new in moves:
        print(f"{old} -> {new}")
    for path in rewrites:
        print(f"Update model labels: {path}")
    if args.apply:
        for old, new in moves:
            old.rename(new)
        for path in rewrites:
            rewrite_merged_slots(path, workflow_labels, rollback=args.rollback)
        print(f"Moved {len(moves)} Czech variants and updated {len(rewrites)} slot files.")
    else:
        print(
            f"Dry run: {len(moves)} Czech variants and {len(rewrites)} slot files. "
            "Pass --apply to migrate them."
        )


if __name__ == "__main__":
    main()
