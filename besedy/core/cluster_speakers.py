#!/usr/bin/env python3
"""Cross-file speaker identification using hierarchical clustering of embeddings.

IMPORTANT: Besedy normally runs this script inside the Docker pyannote worker.
Direct host execution requires pyannote-audio to already be installed in the
current Python environment.

This script:
1. Loads existing speaker diarization JSON files from transcripts/speaker_diarization
2. Extracts speaker embeddings for each segment using GPU (or CPU with --cpu flag)
3. Pools embeddings per speaker per file
4. Uses hierarchical clustering to group speakers across files
5. Shows all speaker pairs sorted by similarity
6. Identifies clusters representing the same person across multiple files

Uses pyannote/embedding for embeddings - requires HF_TOKEN.

Results are saved to transcripts/speaker_clusters/clusters_{model}.json
by default.

Example:
    # Process all files
    uv run python besedy/core/cluster_speakers.py

    # Process specific files using unambiguous hash prefixes
    uv run python besedy/core/cluster_speakers.py 01970259 0252b7eb

    # Force CPU mode (slower but works without GPU)
    uv run python besedy/core/cluster_speakers.py --cpu

    # Adjust clustering distance (lower = stricter clustering)
    uv run python besedy/core/cluster_speakers.py --cluster-distance 0.20
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import torch

from besedy.core.paths import (
    PYANNOTE_DIARIZATION_MODEL_NAME,
    PYANNOTE_DIARIZATION_WORKFLOW_LABEL,
    resolve_transcripts_parent,
)
from besedy.lib.speakers import (
    EmbeddingCache,
    build_embedding_map,
    find_speaker_matches,
    get_hf_token,
    load_embedding_model,
)

# Default paths - use resolve_transcripts_parent() to respect text_data_dir config
_TRANSCRIPTS_PARENT = resolve_transcripts_parent()
DEFAULT_PYANNOTE_SPEAKER_DIR = (
    _TRANSCRIPTS_PARENT
    / "transcripts"
    / PYANNOTE_DIARIZATION_WORKFLOW_LABEL
    / PYANNOTE_DIARIZATION_MODEL_NAME
)
DEFAULT_CLUSTERS_DIR = _TRANSCRIPTS_PARENT / "speaker_clusters"
DEFAULT_EMBEDDING_CACHE_DIR = _TRANSCRIPTS_PARENT / "speaker_embeddings"


def check_args(
    hash_args: list[str],
    input_dir: Path | None = None,
) -> list[Path]:
    """Validate command line arguments and locate speakers.json files.

    Args:
        hash_args: List of hash/path arguments (excluding options).
        input_dir: Directory to search for speakers.json files.

    Returns:
        List of paths to speakers.json files.
    """
    json_files = []

    # Use provided input_dir or default pyannote directory
    search_dir = input_dir if input_dir else DEFAULT_PYANNOTE_SPEAKER_DIR

    # If no arguments, process all files in the directory
    if not hash_args:
        print("No arguments provided - processing all speaker diarization files...")
        print(f"Looking in: {search_dir}")

        if not search_dir.exists():
            print(f"\nError: Directory not found: {search_dir}")
            print(
                "\nUsage: python cluster_speakers.py [--input-dir DIR] [hash1|speakers.json1] [...]"
            )
            print("\nExample with hash prefixes:")
            print("  python cluster_speakers.py 01970259 0252b7eb 02fc9ec4")
            print("\nExample with input directory:")
            print(
                "  python cluster_speakers.py "
                "--input-dir transcripts/speaker_diarization/pyannote_speaker-diarization-community-1"
            )
            print("\nExample with full paths:")
            print("  python cluster_speakers.py \\")
            print(
                "    transcripts/speaker_diarization/.../"
                "0f2fa31aad030970207da2b59a89a49a0abb6172ea486528369ebf997291cc91/"
                "speakers.json \\"
            )
            print(
                "    transcripts/speaker_diarization/.../"
                "4ebc2f98437c9b4a49f1b7d036a4f49c08b8604e494af43373fda0627d791e66/"
                "speakers.json"
            )
            print("\nOr run without arguments to process all files:")
            print("  python cluster_speakers.py")
            sys.exit(1)

        # Find all speakers.json files
        all_speakers_json = sorted(search_dir.glob("*/speakers.json"))

        if not all_speakers_json:
            print(f"\nError: No speakers.json files found in {search_dir}")
            sys.exit(1)

        print(f"Found {len(all_speakers_json)} speaker diarization file(s)")
        for json_path in all_speakers_json:
            print(f"  - {json_path.parent.name}")

        return all_speakers_json

    for arg in hash_args:
        path = Path(arg)

        # If it's a full path to speakers.json
        if path.exists() and path.is_file() and path.name == "speakers.json":
            json_files.append(path)
        # If it's a path to a directory containing speakers.json
        elif path.exists() and path.is_dir():
            speakers_json = path / "speakers.json"
            if speakers_json.exists():
                json_files.append(speakers_json)
            else:
                print(f"Error: No speakers.json found in directory: {path}")
                sys.exit(1)
        # Assume it's a hash - look in search directory
        else:
            # Try exact match first
            hash_dir = search_dir / arg
            speakers_json = hash_dir / "speakers.json"
            if speakers_json.exists():
                json_files.append(speakers_json)
            else:
                # Try glob pattern matching for short hash prefix
                pattern = f"{arg}*"
                matches = list(search_dir.glob(pattern))
                if matches:
                    # Use the first match
                    speakers_json = matches[0] / "speakers.json"
                    if speakers_json.exists():
                        json_files.append(speakers_json)
                        print(f"Found {arg} -> {matches[0].name}")
                    else:
                        print(f"Error: No speakers.json found in matched directory: {matches[0]}")
                        sys.exit(1)
                else:
                    print(f"Error: No speakers.json found for hash '{arg}' at: {hash_dir}")
                    print(f"Looked in: {hash_dir}")
                    print(f"Also tried glob pattern: {search_dir / pattern}")
                    sys.exit(1)

    if not json_files:
        print("Error: No valid speakers.json files found")
        sys.exit(1)

    return json_files


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Cross-file speaker clustering using hierarchical clustering of embeddings",
    )
    parser.add_argument("--cpu", action="store_true", help="Force CPU mode (don't use GPU)")
    parser.add_argument(
        "--model",
        choices=["pyannote"],
        default="pyannote",
        help="Embedding model to use (default: pyannote)",
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        help=(
            "Directory containing speakers.json files (default:"
            " transcripts/speaker_diarization/pyannote_speaker-diarization-community-1)"
        ),
    )
    parser.add_argument(
        "--cluster-distance",
        type=float,
        default=0.35,
        help="Maximum distance for clustering speakers together (default: 0.35)",
    )
    parser.add_argument(
        "--min-duration",
        type=float,
        default=1.0,
        help="Minimum segment duration in seconds (default: 1.0)",
    )
    parser.add_argument(
        "--embedding-cache-mode",
        choices=["none", "file", "segment"],
        default="file",
        help=(
            "Cache embeddings per diarization file ('file', default), "
            "per segment ('segment'), or disable caching ('none')."
        ),
    )
    parser.add_argument(
        "--embedding-cache-dir",
        type=Path,
        help=f"Directory for cached embeddings (default: {DEFAULT_EMBEDDING_CACHE_DIR}).",
    )
    parser.add_argument(
        "--refresh-embedding-cache",
        action="store_true",
        help="Ignore any existing cached embeddings and recompute them.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Save results to JSON file (default: transcripts/speaker_clusters/clusters_{model}.json)",
    )
    parser.add_argument(
        "hashes",
        nargs="*",
        help="Hash prefixes or paths to speakers.json files (processes all if not specified)",
    )

    args = parser.parse_args()

    # Enforce that transcripts symlink (default location) is timestamped when using default input-dir
    if args.input_dir is None:
        transcripts_symlink = _TRANSCRIPTS_PARENT / "transcripts"
        if transcripts_symlink.is_symlink():
            transcripts_root = transcripts_symlink.resolve()
        else:
            transcripts_root = transcripts_symlink
        match = re.search(r"transcripts_(\d{8}_\d{6})$", transcripts_root.name)
        if not match:
            print(
                f"Error: transcripts directory must be timestamped "
                f"(transcripts_<YYYYMMDD_HHMMSS>). Got: {transcripts_root}",
                file=sys.stderr,
            )
            sys.exit(1)

    # Determine which diarization directory to scan
    effective_input_dir = args.input_dir or DEFAULT_PYANNOTE_SPEAKER_DIR

    # Check and load hash arguments
    json_files = check_args(
        args.hashes,
        input_dir=effective_input_dir,
    )

    # Get HF token (required for pyannote)
    hf_token = get_hf_token()

    # Setup device
    if args.cpu:
        device = torch.device("cpu")
        print("\nUsing device: cpu (forced)")
    else:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if device.type == "cuda":
            print(f"\nUsing device: {device} (GPU acceleration enabled)")
        else:
            print("\nUsing device: cpu (no GPU available)")
            print("Warning: CPU mode is significantly slower for embedding extraction")

    # Load embedding model
    embedding_inference, model_name_str = load_embedding_model(hf_token, device, args.model)

    embedding_cache = None
    if args.embedding_cache_mode != "none":
        cache_dir = args.embedding_cache_dir or DEFAULT_EMBEDDING_CACHE_DIR
        embedding_cache = EmbeddingCache(
            mode=args.embedding_cache_mode,
            cache_dir=cache_dir,
            model_name=model_name_str,
            min_duration=args.min_duration,
            refresh=args.refresh_embedding_cache,
        )

    # Process files and extract embeddings
    embeddings = build_embedding_map(
        embedding_inference,
        json_files,
        min_duration=args.min_duration,
        cache=embedding_cache,
    )

    # Generate default output file if not specified
    output_file = args.output
    if output_file is None:
        DEFAULT_CLUSTERS_DIR.mkdir(parents=True, exist_ok=True)
        output_file = DEFAULT_CLUSTERS_DIR / f"clusters_{model_name_str}.json"
        print(f"\nNo output file specified, using default: {output_file}")

    # Find matches
    find_speaker_matches(
        embeddings, cluster_distance=args.cluster_distance, output_file=output_file
    )

    print("\n" + "=" * 60)
    print("Speaker clustering complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
