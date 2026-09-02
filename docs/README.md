# Besedy Documentation

> **Last Updated:** 2026-07-24

AGENTS.md is the starting point. These docs extend it with context that is not obvious from the code.

- [architecture.md](architecture.md) -- pipeline flow, module layers, design decisions
- [adr/](adr/README.md) -- durable architecture decision records and their status
- [data-model.md](data-model.md) -- data contracts: storage layout, transcript/diarization schemas, directory structure
- [patterns.md](patterns.md) -- development guardrails: error handling, CLI output, feature checklist, testing, common pitfalls
- [troubleshooting.md](troubleshooting.md) -- operator runbook: common pipeline errors, causes, and debug commands
- [rag-system.md](rag-system.md) -- ColBERT retrieval architecture and incremental sync
- [rag-oblique-eval.md](rag-oblique-eval.md) -- time-grounded evaluation for implicit retrieval queries
- [backends.md](backends.md) -- ML backend infrastructure: serving, config tuning, verification
- [web/architecture.md](web/architecture.md) -- web app stack, dev patterns, API surface, offline
- [web/jobs-prefect.md](web/jobs-prefect.md) -- preferred Prefect-based jobs orchestration plan with a thin Besedy-owned API facade
- [web/data-and-database.md](web/data-and-database.md) -- web data model, database migration safety, configuration
- [web/security.md](web/security.md) -- auth model, access control, deployment hardening
- [web/mcp-server.md](web/mcp-server.md) -- remote MCP server design: OAuth, access matrix, catalog resolution, telemetry, testing
- [web/mcp-tools.md](web/mcp-tools.md) -- per-tool MCP contract: arguments, result shapes, errors
- [web/mcp-follow-ups.md](web/mcp-follow-ups.md) -- deferred MCP work with the reasons it was deferred
- [web/operations.md](web/operations.md) -- deploy runbook, monitoring, environments
- [schemas/transcript.schema.json](schemas/transcript.schema.json) -- canonical transcript JSON schema
