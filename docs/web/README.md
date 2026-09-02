# Web Application Documentation

> **Last Updated:** 2026-04-09

Documentation for the Besedy web app and adjacent service architecture.

- [architecture.md](architecture.md) -- stack, dev patterns, API surface, offline
- [jobs-prefect.md](jobs-prefect.md) -- preferred Prefect-based execution and API-facade plan for deep-search jobs
- [docker-container-topology.md](docker-container-topology.md) -- Docker container, network, volume, and environment-sharing map for web, shared Prefect, jobs runtimes, and RAG
- [data-and-database.md](data-and-database.md) -- web data model, migration safety, configuration
- [security.md](security.md) -- auth model, access control, deployment hardening
- [mcp-server.md](mcp-server.md) -- remote MCP server design: OAuth, access matrix, catalog resolution, telemetry, testing
- [mcp-tools.md](mcp-tools.md) -- per-tool MCP contract: arguments, result shapes, errors
- [mcp-follow-ups.md](mcp-follow-ups.md) -- deferred MCP work with the reasons it was deferred
- [operations.md](operations.md) -- deploy runbook, monitoring, environments

See [../README.md](../README.md) for the full documentation index.
