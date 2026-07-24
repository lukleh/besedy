# Contributing to Besedy

Besedy is a personal, single-maintainer project, shared in case it is useful.
Contributions and bug reports are welcome, but review is best-effort — please be
patient, and open an issue to discuss anything substantial before investing in a
large change.

The canonical developer workflow, commands, and repo conventions live in
[AGENTS.md](AGENTS.md); this file is a short on-ramp. For security issues, do
**not** open a public issue — see [SECURITY.md](SECURITY.md).

## Getting Started

Besedy has primarily two parts: a Python speech-to-text toolkit (`besedy/`) and
a Next.js web app (`web/`).

- **Python** — needs Python 3.13, [uv](https://docs.astral.sh/uv/), and
  `ffmpeg`/`ffprobe` on `PATH`. Install the core/dev environment:

  ```bash
  just setup          # lean core + dev deps (uv sync)
  # optional extras:
  just setup-ml       # RAG, speaker, and workflow helpers
  just setup-jobs     # Prefect jobs tooling
  ```

  Run Python via `uv run …` (or a `just` wrapper), never plain `python`.

- **Web app** — needs Node and Docker; the dev/test/prod stacks run in Docker.
  See the "Web App" section of [AGENTS.md](AGENTS.md) and
  [docs/web/operations.md](docs/web/operations.md).

- **ML backends** — the ASR and diarization backends run as Docker
  images and need model downloads. Much of the pipeline can be explored without
  them, but backend-dependent work requires building the relevant image by
  service name (e.g. `docker compose -f backends/docker-compose.yml build
  whisperx`; see the compose file for the full list of backend services).

## Checks Before Opening a PR

Run the checks relevant to what you touched:

```bash
just ruff          # Python lint (ruff check)
just ruff-format   # Python formatting
just ty            # Python type check
just test          # Python test suite (pytest; = uv run --all-extras pytest)

just web-check     # web: TypeScript + ESLint + unit tests
```

`ruff` and `ty` run against the project's current lint/type surface, not the
whole tree — match the style and typing of the code around your change. Web
end-to-end tests run against a hardened production build via Docker
(`cd web && npm run test:e2e`); see [AGENTS.md](AGENTS.md) for the full E2E
command set.

Add tests for new behaviour. If a test needs `ffmpeg`, a GPU, or external data,
mark it (`integration`, `gpu`, `slow`, `e2e` — see `pytest.ini`).

## Pull Requests

- Keep changes focused; avoid unrelated refactors in the same PR.
- Commit subjects: short and imperative (≤72 chars); explain intent in the body
  when it helps.
- In the PR description, say what changed and include the exact verification
  commands you ran.
- Respect the "Important Constraints" and "Database Migrations" sections of
  [AGENTS.md](AGENTS.md) — the storage-layout invariants and migration rules are
  easy to break.

## Code Style

- 4-space indent; `snake_case` functions/variables, `PascalCase` classes,
  `UPPER_SNAKE_CASE` constants.
- Keep CLI modules thin: argument parsing in `besedy/cli/*`, logic in
  `besedy/commands/*` and `besedy/lib/*`.
- Prefer structured logging and clear error messages over ad-hoc prints.

See [AGENTS.md](AGENTS.md) for the complete conventions.
