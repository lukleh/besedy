# ADR 0004: System responsibility boundaries

- **Status:** Accepted
- **Date:** 2026-07-15
- **Canonical references:** [Architecture](../architecture.md), [web architecture](../web/architecture.md), [Prefect jobs](../web/jobs-prefect.md)

## Context

Besedy combines local batch processing, heavyweight GPU runtimes, an interactive
web application, and long-running deep-search jobs. Treating all code as one
runtime would couple lightweight catalog commands to ML and web dependencies.

## Decision

- The Python package owns catalog ingestion, audio preparation, canonical
  transcript conversion, validation, and workflow orchestration.
- Backend containers own model-specific GPU dependency stacks.
- The Next.js application owns interactive HTTP behavior, authorization,
  PostgreSQL serving models, and controlled filesystem delivery.
- The jobs API and Prefect workers own asynchronous deep-search lifecycle and
  communicate with the web service through authenticated internal contracts.

Inside Python, dependency direction is CLI → commands/workflows → reusable
library/core modules. Reusable libraries do not depend on CLI parsing or command
presentation helpers. Cross-runtime contracts are versioned data or HTTP
contracts rather than imports into another runtime's presentation layer.

## Consequences

- Optional ML and jobs dependencies stay outside the lightweight core install.
- Production service images should contain immutable application code and expose
  only the state and credentials required for their role.
- Boundary violations should be covered by import and contract tests.
- Shared concepts need one canonical owner instead of duplicated constants.
