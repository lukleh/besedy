#!/bin/bash
# Download and convert a Whisper model to local CTranslate2 format for faster-whisper.
#
# This script uses the Dockerized faster-whisper worker and runs
# ct2-transformers-converter to produce a local model directory with model.bin.
#
# Usage examples:
#   ./backends/faster-whisper/convert_model.sh
#   ./backends/faster-whisper/convert_model.sh \
#       --model mikr/whisper-large-v3-czech-cv13 \
#       --output-dir /path/to/whisper_models/whisper-large-v3-czech-cv13-ct2
#   ./backends/faster-whisper/convert_model.sh --quantization int8

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/backends/docker-compose.yml"
SERVICE="faster-whisper"

MODEL="mikr/whisper-large-v3-czech-cv13"
OUTPUT_DIR="$HOME/whisper_models/whisper-large-v3-czech-cv13-ct2"
QUANTIZATION="float16"
FORCE=0

usage() {
    cat <<'EOF'
Usage:
  ./backends/faster-whisper/convert_model.sh [options]

Options:
  --model <id-or-path>        Source Hugging Face model ID or local transformers path.
                              Default: mikr/whisper-large-v3-czech-cv13
  --output-dir <path>         Output directory for converted CTranslate2 model.
                              Default: ~/whisper_models/whisper-large-v3-czech-cv13-ct2
  --quantization <type>       CTranslate2 quantization type.
                              One of: int8, int8_float32, int8_float16, int8_bfloat16,
                                      int16, float16, bfloat16, float32
                              Default: float16
  --force                     Overwrite output directory if it exists.
  -h, --help                  Show this help.

Notes:
  - Builds and runs the Docker faster-whisper worker.
  - The source model must contain preprocessor_config.json. faster-whisper
    reads the mel bin count (feature_size) from it and silently assumes 80
    without it; large-v3 models need 128. transformers 5
    processor.save_pretrained() writes only processor_config.json, so save
    the feature extractor as well before converting a fine-tuned model:
      processor.feature_extractor.save_pretrained(model_dir)
  - Private/gated HF models require authentication:
      HF_TOKEN=... ./backends/faster-whisper/convert_model.sh ...
EOF
}

is_valid_quantization() {
    case "$1" in
        int8|int8_float32|int8_float16|int8_bfloat16|int16|float16|bfloat16|float32)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)
            MODEL="${2:-}"
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR="${2:-}"
            shift 2
            ;;
        --quantization)
            QUANTIZATION="${2:-}"
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            echo ""
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$MODEL" ]]; then
    echo "Error: --model cannot be empty."
    exit 1
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    echo "Error: --output-dir cannot be empty."
    exit 1
fi

MODEL="${MODEL/#\~/$HOME}"
OUTPUT_DIR="${OUTPUT_DIR/#\~/$HOME}"

if ! is_valid_quantization "$QUANTIZATION"; then
    echo "Error: invalid --quantization '$QUANTIZATION'."
    exit 1
fi

if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed or not in PATH."
    exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "Error: compose file not found: $COMPOSE_FILE"
    exit 1
fi

resolve_path_with_missing_leaf() {
    local raw="$1"
    local dir
    local base

    dir="$(dirname "$raw")"
    base="$(basename "$raw")"
    mkdir -p "$dir"
    dir="$(cd "$dir" && pwd)"
    printf '%s/%s\n' "$dir" "$base"
}

OUTPUT_DIR="$(resolve_path_with_missing_leaf "$OUTPUT_DIR")"
mkdir -p "$(dirname "$OUTPUT_DIR")"

if [[ -e "$OUTPUT_DIR" ]] && [[ $FORCE -ne 1 ]]; then
    if find "$OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null | grep -q .; then
        echo "Error: output directory exists and is not empty: $OUTPUT_DIR"
        echo "Use --force to overwrite."
        exit 1
    fi
fi

MODEL_ARG="$MODEL"
MODEL_MOUNT=""
if [[ -e "$MODEL" ]]; then
    if [[ -d "$MODEL" ]]; then
        MODEL_MOUNT="$(cd "$MODEL" && pwd)"
        MODEL_ARG="$MODEL_MOUNT"
    else
        MODEL_MOUNT="$(cd "$(dirname "$MODEL")" && pwd)"
        MODEL_ARG="$MODEL_MOUNT/$(basename "$MODEL")"
    fi
fi

# A Hub model without the file still fails inside the converter, but only
# after the whole model has been loaded.
if [[ -d "$MODEL_ARG" ]] && [[ ! -f "$MODEL_ARG/preprocessor_config.json" ]]; then
    echo "Error: $MODEL_ARG has no preprocessor_config.json."
    echo "faster-whisper would fall back to 80 mel bins (large-v3 needs 128)."
    echo "transformers 5 processor.save_pretrained() writes only processor_config.json;"
    echo "also run processor.feature_extractor.save_pretrained(\"$MODEL_ARG\")."
    exit 1
fi

XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
HF_HOME="${HF_HOME:-$XDG_CACHE_HOME/huggingface}"
HF_HUB_CACHE="${HF_HUB_CACHE:-$HF_HOME/hub}"
TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$HF_HOME/transformers}"
TORCH_HOME="${TORCH_HOME:-$XDG_CACHE_HOME/torch}"
# The image has no passwd entry for the host uid. torch._dynamo (imported by
# transformers' Whisper model) calls getpass.getuser(), which then needs USER
# or LOGNAME, and HOME would default to an unwritable /. Same values as
# besedy/lib/runtime/backend_runtime.py uses for backend runs.
DOCKER_HOME="${BESEDY_DOCKER_HOME:-$XDG_CACHE_HOME/home}"
DOCKER_USER="${USER:-${LOGNAME:-$(id -un)}}"

mkdir -p "$XDG_CACHE_HOME" "$HF_HOME" "$HF_HUB_CACHE" "$TRANSFORMERS_CACHE" "$TORCH_HOME" "$DOCKER_HOME"

echo "=== faster-whisper Model Conversion ==="
echo "Project root: $PROJECT_ROOT"
echo "Compose file: $COMPOSE_FILE"
echo "Source model: $MODEL_ARG"
echo "Output dir: $OUTPUT_DIR"
echo "Quantization: $QUANTIZATION"
echo ""

echo "=== Building Docker image ==="
docker compose -f "$COMPOSE_FILE" build "$SERVICE"

run_base=(
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps
    --user "$(id -u):$(id -g)"
    -v "$(dirname "$OUTPUT_DIR"):$(dirname "$OUTPUT_DIR"):rw"
    -v "$XDG_CACHE_HOME:$XDG_CACHE_HOME:rw"
    -v "$DOCKER_HOME:$DOCKER_HOME:rw"
    -v "$HF_HOME:$HF_HOME:rw"
    -v "$HF_HUB_CACHE:$HF_HUB_CACHE:rw"
    -v "$TRANSFORMERS_CACHE:$TRANSFORMERS_CACHE:rw"
    -v "$TORCH_HOME:$TORCH_HOME:rw"
    -e "XDG_CACHE_HOME=$XDG_CACHE_HOME"
    -e "HF_HOME=$HF_HOME"
    -e "HF_HUB_CACHE=$HF_HUB_CACHE"
    -e "TRANSFORMERS_CACHE=$TRANSFORMERS_CACHE"
    -e "TORCH_HOME=$TORCH_HOME"
    -e "HOME=$DOCKER_HOME"
    -e "USER=$DOCKER_USER"
    -e "LOGNAME=$DOCKER_USER"
)

if [[ -n "$MODEL_MOUNT" ]]; then
    run_base+=(-v "$MODEL_MOUNT:$MODEL_MOUNT:ro")
fi

if [[ -n "${HF_TOKEN:-}" ]]; then
    run_base+=(-e "HF_TOKEN=$HF_TOKEN")
fi

# No config.json here: the converter writes its own (alignment heads, language
# ids, suppressed tokens) and CTranslate2 refuses to overwrite it with a copy.
cmd=(
    "${run_base[@]}"
    "$SERVICE"
    ct2-transformers-converter
    --model "$MODEL_ARG"
    --output_dir "$OUTPUT_DIR"
    --quantization "$QUANTIZATION"
    --copy_files tokenizer.json tokenizer_config.json preprocessor_config.json generation_config.json
)

if [[ $FORCE -eq 1 ]]; then
    cmd+=(--force)
fi

"${cmd[@]}"

if [[ ! -f "$OUTPUT_DIR/model.bin" ]]; then
    echo "Error: conversion finished but model.bin is missing in $OUTPUT_DIR"
    exit 1
fi

# A preprocessor_config.json saved from a different base model would still
# give faster-whisper the wrong mel bin count, so compare it with the model.
echo ""
echo "=== Checking mel bin count ==="
"${run_base[@]}" "$SERVICE" python -c '
import json, sys
from transformers import AutoConfig

model, output_dir = sys.argv[1:3]
expected = AutoConfig.from_pretrained(model).num_mel_bins
with open(f"{output_dir}/preprocessor_config.json", encoding="utf-8") as fh:
    actual = json.load(fh).get("feature_size")
if actual != expected:
    sys.exit(
        f"Error: preprocessor_config.json has feature_size={actual}, "
        f"but the model expects num_mel_bins={expected}."
    )
print(f"feature_size={actual} matches num_mel_bins")
' "$MODEL_ARG" "$OUTPUT_DIR"

echo ""
echo "=== Conversion complete ==="
echo "Local CTranslate2 model ready at:"
echo "  $OUTPUT_DIR"
echo ""
echo "Use this in besedy.toml:"
echo "  model = \"$OUTPUT_DIR\""
