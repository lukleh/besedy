FROM python:3.11-slim-bookworm

ARG FASTER_WHISPER_VERSION=1.2.1
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
        ctranslate2 \
        "faster-whisper==${FASTER_WHISPER_VERSION}" \
        "silero-vad==${SILERO_VAD_VERSION}" \
        safetensors \
        numpy \
        python-dotenv \
        pyyaml \
        scipy \
        sentencepiece \
        soundfile \
        transformers \
        tqdm

CMD ["python", "-c", "import faster_whisper; from faster_whisper import WhisperModel; from faster_whisper.vad import VadOptions; print(faster_whisper.__version__)"]
