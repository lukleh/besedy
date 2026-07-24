#!/usr/bin/env python3
"""Pyannote speaker diarization workflow.

Runs speaker diarization on audio files and saves results to
speaker_diarization/{model}/{hash}/speakers.json

"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

# Limit thread usage to prevent overwhelming the system when running multiple parallel workers.
# This must be done before importing torch/torchaudio/numpy/etc.
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "4")

import torch
from huggingface_hub import get_token

from besedy.core.paths import resolve_transcripts_root
from besedy.lib.speakers.compat import (
    load_audio_with_soundfile,
    suppress_pyannote_torchcodec_warning,
)
from besedy.lib.workflow.paths import setup_diarization_output_dir

with suppress_pyannote_torchcodec_warning():
    from pyannote.audio import Pipeline
    from pyannote.audio.pipelines.utils.hook import ProgressHook

# Also limit PyTorch's intraop parallelism
torch.set_num_threads(4)

MODEL_NAME = "pyannote_speaker-diarization-community-1"
SPEAKER_DIARIZATION_DIR = "speaker_diarization"


def run_diarization(
    pipeline: Pipeline,
    audio_path: Path,
    output_dir: Path,
    use_progress: bool = True,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    clustering_threshold: float | None = None,
) -> dict:
    """Run speaker diarization on audio file.

    Args:
        pipeline: Pyannote pipeline instance
        audio_path: Path to audio file
        output_dir: Output directory for results
        use_progress: Show progress bar
        min_speakers: Minimum number of speakers to detect (default: None = auto)
        max_speakers: Maximum number of speakers to detect (default: None = auto)
        clustering_threshold: Clustering threshold (default: None = model default 0.6)
            Range: 0.0-2.0 (VBx clustering)
            Lower values (0.3-0.5) = more sensitive = MORE speakers detected
            Higher values (0.7-0.9) = less sensitive = FEWER speakers detected
            Default 0.6 is balanced (pyannote 4.0 with VBx clustering)

    Returns:
        Dict with diarization results
    """
    print(f"Processing: {audio_path}")

    waveform, sample_rate = load_audio_with_soundfile(audio_path)
    audio_input = {
        "waveform": waveform,
        "sample_rate": sample_rate,
        "uri": str(audio_path),
    }

    # Build pipeline parameters
    pipeline_params = {}

    if min_speakers is not None:
        pipeline_params["min_speakers"] = min_speakers
        print(f"  min_speakers: {min_speakers}")

    if max_speakers is not None:
        pipeline_params["max_speakers"] = max_speakers
        print(f"  max_speakers: {max_speakers}")

    if clustering_threshold is not None:
        pipeline_params["clustering"] = {"threshold": clustering_threshold}
        print(f"  clustering_threshold: {clustering_threshold}")

    # Apply pretrained pipeline
    if use_progress:
        with ProgressHook() as hook:
            output = pipeline(audio_input, hook=hook, **pipeline_params)
    else:
        output = pipeline(audio_input, **pipeline_params)

    # Convert to JSON-serializable format
    speakers = []
    for turn, speaker in output.speaker_diarization:
        speakers.append(
            {
                "start": round(turn.start, 3),
                "end": round(turn.end, 3),
                "speaker": str(speaker),
            }
        )

    result = {
        "audio_file": str(audio_path),
        "model": MODEL_NAME,
        "num_speakers": len(set(s["speaker"] for s in speakers)),
        "segments": speakers,
    }

    # Save to speakers.json
    output_file = output_dir / "speakers.json"
    with output_file.open("w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    print(f"Saved diarization to: {output_file}")
    print(f"Detected {result['num_speakers']} speaker(s), {len(speakers)} segment(s)")

    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run pyannote speaker diarization on audio files")
    parser.add_argument(
        "--audio",
        nargs="+",
        required=True,
        help="Audio file(s) to process",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Output root directory (default: transcripts/speaker_diarization)",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable progress bar",
    )
    parser.add_argument(
        "--cpu",
        action="store_true",
        help="Force CPU mode (don't use GPU even if available)",
    )
    parser.add_argument(
        "--min-speakers",
        type=int,
        default=None,
        help="Minimum number of speakers to detect (default: auto)",
    )
    parser.add_argument(
        "--max-speakers",
        type=int,
        default=None,
        help="Maximum number of speakers to detect (default: auto)",
    )
    parser.add_argument(
        "--clustering-threshold",
        type=float,
        default=None,
        help="Clustering threshold for speaker separation (default: 0.6, range: 0.0-2.0). "
        "Lower values (0.3-0.5) detect MORE speakers, "
        "higher values (0.7-0.9) detect FEWER speakers. "
        "Uses VBx clustering (pyannote 4.0).",
    )

    args = parser.parse_args(argv)

    # Get HF token from environment or cached login
    hf_token = os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_TOKEN")
    if not hf_token:
        try:
            hf_token = get_token()
        except Exception as exc:  # defensive fallback
            print(f"Warning: unable to read cached Hugging Face token ({exc})", file=sys.stderr)
            hf_token = None

    if not hf_token:
        print("Error: No Hugging Face token found (env vars or 'hf auth login')", file=sys.stderr)
        print("Please export HF_TOKEN/HUGGINGFACE_TOKEN or run 'hf auth login'", file=sys.stderr)
        return 1

    # Setup output directory
    if args.output_dir:
        output_root = args.output_dir
    else:
        # When called standalone, use transcripts/speaker_diarization as the base
        output_root = resolve_transcripts_root() / SPEAKER_DIARIZATION_DIR

    output_root = output_root.expanduser().resolve()

    # Load pipeline once
    print("Loading pyannote speaker diarization pipeline...")
    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1", token=hf_token
        )
    except Exception as e:
        print(f"Error loading pipeline: {e}", file=sys.stderr)
        return 1

    # Send pipeline to GPU (when available)
    if args.cpu:
        device = torch.device("cpu")
    else:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    print(f"Using device: {device}")
    pipeline.to(device)

    # Process each audio file
    success_count = 0
    for audio_file_str in args.audio:
        audio_path = Path(audio_file_str).expanduser().resolve()

        if not audio_path.exists():
            print(f"Error: Audio file not found: {audio_path}", file=sys.stderr)
            continue

        try:
            output_dir, hash_component = setup_diarization_output_dir(
                output_root, audio_path, MODEL_NAME
            )
            run_diarization(
                pipeline,
                audio_path,
                output_dir,
                use_progress=not args.no_progress,
                min_speakers=args.min_speakers,
                max_speakers=args.max_speakers,
                clustering_threshold=args.clustering_threshold,
            )
            success_count += 1
            print()
        except Exception as e:
            print(f"Error processing {audio_path}: {e}", file=sys.stderr)
            traceback.print_exc()
            continue

    print("=" * 60)
    print(f"Completed: {success_count}/{len(args.audio)} files processed successfully")

    return 0 if success_count == len(args.audio) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
