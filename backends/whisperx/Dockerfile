FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3

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

COPY backends/whisperx/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-deps -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

CMD ["python", "-c", "from importlib.metadata import version; print(version('whisperx'))"]
