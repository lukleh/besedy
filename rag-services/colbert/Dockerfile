FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04@sha256:24c8e3581ea6330038b0d374920721983312627f8adbfcf390bdb4b399d280ed

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/hf \
    HF_HUB_CACHE=/data/hf/hub \
    TRANSFORMERS_CACHE=/data/hf/transformers \
    TORCH_HOME=/data/torch \
    VIRTUAL_ENV=/opt/colbert-venv \
    PATH=/opt/colbert-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    build-essential \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY rag-services/colbert/requirements.lock /tmp/requirements.lock
RUN python3 -m venv "$VIRTUAL_ENV" \
    && python -m pip install --no-deps -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

RUN mkdir -p /data/hf /data/torch \
    && chmod 0777 /data /data/hf /data/torch

WORKDIR /workspace/besedy

CMD ["python", "-m", "besedy.lib.rag_colbert_runtime.server", "--host", "0.0.0.0", "--port", "8192"]
