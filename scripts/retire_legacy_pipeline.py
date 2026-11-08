"""Explicit retirement of obsolete pipeline files; dry-run unless --apply is given.

Run as ``uv run python -m scripts.retire_legacy_pipeline --help``. Routine
pipeline readers never call this module. Retiring valuable files requires a
JSON snapshot of referenced paths and a separate destination for safekeeping.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tomllib
from pathlib import Path

from besedy.lib.data.atomic_io import atomic_write_text

ALGORITHM_MARKER = "# besedy-audio-hash-algorithm: pcm-s16le-16000hz-mono-sha256-v1"
RETIRED_WEB_KEY = "deep_search_default_instructions"


def without_retired_web_key(raw: str) -> str:
    """Remove one TOML assignment, preserving every unrelated byte."""
    document = tomllib.loads(raw)
    if RETIRED_WEB_KEY not in document.get("web", {}):
        return raw
    lines = raw.splitlines(keepends=True)
    in_web = False
    for index, line in enumerate(lines):
        if line.lstrip().startswith("["):
            in_web = line.split("#", 1)[0].strip() == "[web]"
        if not in_web or not re.match(rf"\s*{RETIRED_WEB_KEY}\s*=", line):
            continue
        for end in range(index + 1, len(lines) + 1):
            try:
                assignment = tomllib.loads("[web]\n" + "".join(lines[index:end]))
            except tomllib.TOMLDecodeError:
                continue
            if RETIRED_WEB_KEY not in assignment.get("web", {}):
                break
            updated = "".join(lines[:index] + lines[end:])
            expected = {**document, "web": dict(document["web"])}
            del expected["web"][RETIRED_WEB_KEY]
            if tomllib.loads(updated) != expected:
                break
            return updated
    raise ValueError("Cannot isolate the retired TOML assignment; remove it manually")


def markerless_sidecars(root: Path):
    """Find recomputable sidecars without the current identity markers."""
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = [
            name
            for name in directories
            if not name.startswith(".")
            and name != "@eaDir"
            and not Path(directory, name).is_symlink()
        ]
        for name in files:
            path = Path(directory, name)
            if name.startswith("._") or not name.endswith(".audiohash") or path.is_symlink():
                continue
            if path.stat().st_size > 8192:
                raise ValueError(f"Oversized sidecar needs manual inspection: {path}")
            lines = path.read_text(encoding="utf-8").splitlines()
            current_algorithm = ALGORITHM_MARKER in (line.strip() for line in lines[1:])
            current_source = any(
                re.fullmatch(r"# besedy-source-file-sha256: [0-9a-fA-F]{64}", line.strip())
                for line in lines[1:]
            )
            if not current_algorithm or not current_source:
                yield path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sidecars-root", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--retire-file", type=Path, action="append", default=[])
    parser.add_argument(
        "--references-json", type=Path, help="JSON array of all active DB/config path references"
    )
    parser.add_argument("--retired-dir", type=Path, help="Destination outside every live data root")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if not (args.sidecars_root or args.config or args.retire_file):
        parser.error("Choose a sidecar root, config, or explicit file to retire")

    try:
        sidecars = list(markerless_sidecars(args.sidecars_root)) if args.sidecars_root else []
        config = args.config.resolve(strict=True) if args.config else None
        old_config = config.read_text(encoding="utf-8") if config else None
        new_config = without_retired_web_key(old_config) if old_config is not None else None
        retired = [path.resolve(strict=True) for path in args.retire_file]
        if retired and (not args.references_json or not args.retired_dir):
            raise ValueError(
                "Retiring files requires --references-json and --retired-dir, including for dry-run"
            )
        references = []
        if args.references_json:
            raw_references = json.loads(args.references_json.read_text(encoding="utf-8"))
            if not isinstance(raw_references, list) or not all(
                isinstance(p, str) and Path(p).is_absolute() for p in raw_references
            ):
                raise ValueError("References must be a JSON array of absolute host paths")
            references = [Path(path).resolve() for path in raw_references]
        destination = args.retired_dir.resolve() if args.retired_dir else None
        for path in retired:
            if not path.is_file():
                raise ValueError(f"Only individual regular files can be retired: {path}")
            if any(
                path == reference or reference in path.parents or path in reference.parents
                for reference in references
            ):
                raise ValueError(f"Refusing to retire referenced file: {path}")
            if destination is None or (destination / path.name).exists():
                raise ValueError(f"Retirement destination already exists for {path.name}")
        if len({path.name for path in retired}) != len(retired):
            raise ValueError("Retired files have colliding destination names")

        plan = {
            "apply": args.apply,
            "invalidate_sidecars": [str(path) for path in sidecars],
            "remove_retired_config_key": bool(config and old_config != new_config),
            "retire_files": [str(path) for path in retired],
        }
        print(json.dumps(plan, indent=2))
        if args.apply:
            if config and old_config != new_config:
                assert new_config is not None
                atomic_write_text(config, new_config)
            for path in sidecars:
                path.unlink()
            if retired:
                assert destination is not None
                destination.mkdir(parents=True, exist_ok=True)
                for path in retired:
                    shutil.move(str(path), destination / path.name)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"Error: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
