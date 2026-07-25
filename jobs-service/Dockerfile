# syntax=docker/dockerfile:1.7

FROM ghcr.io/astral-sh/uv:0.9.26 AS uv

FROM python:3.13-slim AS builder

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app

# Refresh Rlmbenchy's moving default branch before resolving the jobs
# environment. The Justfile changes this argument for each jobs image build so
# Docker cannot reuse a dependency layer resolved from an older branch head.
ARG RLMBENCHY_REFRESH=manual
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN echo "Refreshing Rlmbenchy dependency (${RLMBENCHY_REFRESH})" \
    && uv lock --upgrade-package rlmbenchy \
    && uv sync --frozen --no-dev --extra jobs --no-install-project

COPY besedy ./besedy
RUN uv sync --frozen --no-dev --extra jobs --no-editable \
    && uv pip check --python /opt/venv/bin/python \
    && /opt/venv/bin/python -c \
        'from besedy.lib.prefect_jobs.rlm_integration import BesedyDeepSearchSignature; from rlmbenchy.rlm import load_lm_profile, run_task' \
    && rm -rf /app/besedy

FROM python:3.13-slim

ARG JOBS_UID=1000
ARG JOBS_GID=1000

ENV PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    HOME=/home/besedy \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    XDG_DATA_HOME=/tmp/data \
    XDG_STATE_HOME=/tmp/state \
    DSPY_CACHEDIR=/tmp/cache/dspy \
    PREFECT_HOME=/tmp/prefect

RUN groupadd --gid "${JOBS_GID}" besedy \
    && useradd --uid "${JOBS_UID}" --gid "${JOBS_GID}" --create-home --shell /usr/sbin/nologin besedy \
    && mkdir -p /run/besedy/config /run/codex

COPY --from=builder /opt/venv /opt/venv

ARG REQUIRE_PROVENANCE=false
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
RUN if [ "$REQUIRE_PROVENANCE" = "true" ]; then \
      test -n "$GIT_COMMIT" && test "$GIT_COMMIT" != "unknown" \
      && test -n "$BUILD_TIME" && test "$BUILD_TIME" != "unknown" \
      || { echo "Production image provenance arguments must be set." >&2; exit 1; }; \
    fi
LABEL org.opencontainers.image.title="Besedy jobs runtime" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIME}"

WORKDIR /home/besedy
USER besedy:besedy

CMD ["python", "-m", "besedy.lib.prefect_jobs.server"]
