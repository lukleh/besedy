FROM python:3.11-slim-bookworm@sha256:2333bd330d12de02514770b3585cad313644316047cdee24a7acfdece6de6efb

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

COPY backends/faster-whisper/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-deps -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

CMD ["python", "-c", "import faster_whisper; from faster_whisper import WhisperModel; from faster_whisper.vad import VadOptions; print(faster_whisper.__version__)"]
