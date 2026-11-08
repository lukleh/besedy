FROM python:3.12-slim-bookworm@sha256:54c85f3c47607a77f32adec749d3c81d1348bf25833671f512b26a9b6d778cb3

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    CUDA_HOME=/usr/local/lib/python3.12/site-packages/nvidia/cuda_nvcc \
    TORCHINDUCTOR_CACHE_DIR=/tmp/torchinductor \
    NUMBA_CACHE_DIR=/tmp/numba

# NeMo 3.1's Triton kernels build a small C launcher during inference.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        gcc \
        libc6-dev \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Independent from the Canary image: new RNNT models require NeMo 3.1, while
# Canary keeps its existing locked runtime. The source archive is commit- and
# SHA256-pinned in the lock, along with the complete CUDA/Python package set.
# As in the Canary lock, nvidia-resiliency-ext is deliberately absent because
# its current wheels require a newer glibc than Debian bookworm provides.
COPY backends/nemo-rnnt/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-deps -r /tmp/requirements.lock \
    && python -m pip check \
    && rm /tmp/requirements.lock

RUN python -c "import nemo; from nemo.collections.asr.models import EncDecRNNTBPEModelWithPrompt; from silero_vad import load_silero_vad; assert nemo.__version__ == '3.1.0'; load_silero_vad()"

CMD ["python", "-c", "import nemo; from nemo.collections.asr.models import EncDecRNNTBPEModelWithPrompt; print(nemo.__version__)"]
