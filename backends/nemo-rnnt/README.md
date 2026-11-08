# NeMo RNNT worker

The optional `nemo-rnnt` service runs prompted RNNT checkpoints, initially
`nvidia/nemotron-labs-unified-asr-0.6b`, through NeMo Speech 3.1. Canary continues
to use the separate `nemo` service and its NeMo 2.6.1 lock.

Build from the repository root:

```bash
docker compose -f backends/docker-compose.yml build nemo-rnnt
```

`BESEDY_NEMO_RNNT_IMAGE` can select a separate local build tag for comparisons.
The image is always built from this checkout and never pulled from a registry.

The complete Python package set is pinned in `requirements.lock`, including a
commit- and SHA256-pinned NeMo source archive. It uses Python 3.12 and Torch
2.11.0 with CUDA 12.8. The C compiler and headers support Triton's runtime
launcher; the CUDA compiler wheel supplies RNNT loss's NVVM libraries.
Persistent model/cache mounts and the invoking UID/GID are supplied by the
shared backend runtime, as for the other workers. Torch compilation caches use
the ephemeral container's writable `/tmp`.

For a CPU-only dependency check:

```bash
docker run --rm --entrypoint python besedy/nemo-rnnt:local -m pip check
docker run --rm besedy/nemo-rnnt:local
```

Full inference requires the NVIDIA Container Toolkit and the serialized GPU
worker. The CLI rejects CPU execution for this backend.
