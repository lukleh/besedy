FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor \
    NUMBA_CACHE_DIR=/tmp/numba

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# ARK's pinned custom model subclasses Transformers 4.57's Qwen2 and Whisper
# implementations. Keep it independent of both NeMo and newer Transformers
# images; SDPA works without compiling FlashAttention.
COPY backends/ark-asr/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-deps -r /tmp/requirements.lock \
    && python -m pip check \
    && rm /tmp/requirements.lock

# Exercise the real custom-model dependencies and CPU ONNX VAD without CUDA.
RUN python -c "from transformers import AutoProcessor, Qwen2ForCausalLM; from transformers.models.whisper.modeling_whisper import WhisperEncoder; import librosa, soundfile; from silero_vad import load_silero_vad; load_silero_vad(onnx=True)"

CMD ["python", "-c", "import torch, transformers; print(torch.__version__, transformers.__version__)"]
