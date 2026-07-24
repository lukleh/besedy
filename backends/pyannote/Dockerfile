FROM python:3.11-slim-bookworm

ARG PYANNOTE_AUDIO_VERSION=4.0.1

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio \
    && python -m pip install \
        "pyannote-audio==${PYANNOTE_AUDIO_VERSION}" \
        huggingface-hub \
        numpy \
        omegaconf \
        python-dotenv \
        pyyaml \
        scipy \
        soundfile \
        toml \
        tqdm

CMD ["python", "-c", "import pyannote.audio; print(pyannote.audio.__version__)"]
