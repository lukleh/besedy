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
    && python -m pip install "nemo-toolkit[asr,nlp]==2.6.1" \
    && python -m pip install \
        omegaconf \
        "numpy<2.4" \
        pyyaml \
        python-dotenv \
        scipy \
        soundfile \
        tqdm \
    # megatron-core 0.17.1 (pulled in by the nemo [nlp] extra) requires
    # nvidia-resiliency-ext>=0.6.0 and reads its __version__ at import time. nvrx
    # 0.6.0 exists on PyPI but its wheels (0.5.0+) target manylinux_2_39
    # (glibc >= 2.39); this image is Debian bookworm (glibc 2.36), so pip caps
    # nvrx at 0.4.1, which lacks __version__ and is below the 0.6.0 minimum. Any
    # installed nvrx therefore crashes the import of megatron.core (and thus
    # nemo.collections.asr). nvrx only provides distributed-training async
    # checkpointing, which ASR inference does not use, so removing it lets
    # has_nvrx_async_support() short-circuit to False cleanly. (Alternative, not
    # taken: move to a glibc >= 2.39 base so nvrx 0.6.0 installs.)
    && python -m pip uninstall -y nvidia-resiliency-ext

RUN python - <<'PY'
from pathlib import Path

from torch.utils.data import Sampler

try:
    import lhotse
except Exception as exc:
    print(f"Skipping lhotse patch (import failed: {exc})")
    raise SystemExit(0)

if Sampler.__init__ is object.__init__:
    base = Path(lhotse.__file__).resolve().parent / "dataset" / "sampling" / "base.py"
    if not base.exists():
        print("Warning: lhotse base.py not found; skipping patch.")
        raise SystemExit(0)
    lines = base.read_text().splitlines()
    target_block = [
        "        super().__init__(",
        "            data_source=None",
        "        )  # the \"data_source\" arg is not used in Sampler...",
    ]
    for idx in range(len(lines) - len(target_block) + 1):
        if lines[idx : idx + len(target_block)] == target_block:
            lines[idx : idx + len(target_block)] = [
                "        super().__init__()  # the \"data_source\" arg is not used in Sampler..."
            ]
            base.write_text("\n".join(lines) + "\n")
            print("Patched lhotse CutSampler super().__init__ for torch sampler compatibility.")
            break
PY

CMD ["python", "-c", "import nemo; from nemo.collections.asr.models import ASRModel; from lhotse.dataset.sampling import DynamicCutSampler; print(nemo.__version__)"]
