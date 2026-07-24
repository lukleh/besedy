FROM python:3.13-slim-bookworm

ARG QWEN_ASR_VERSION=0.0.6
ARG SILERO_VAD_VERSION=6.2.0

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio torchvision \
    && python -m pip install \
        "qwen-asr==${QWEN_ASR_VERSION}" \
        "silero-vad==${SILERO_VAD_VERSION}" \
        numpy \
        python-dotenv \
        scipy \
        soundfile \
        tqdm

CMD ["python", "-c", "import qwen_asr; from silero_vad import load_silero_vad; print('qwen-asr ok')"]
