FROM python:3.12-slim-bookworm

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
    && python -m pip install whisperx python-dotenv \
    && python -m pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio torchvision

CMD ["python", "-c", "from importlib.metadata import version; print(version('whisperx'))"]
