# Architecture Decision Records

ADRs capture decisions whose rationale spans more than one module or service.
They do not replace the canonical operational and data-contract documentation;
each record links to those references.

## Status meanings

- **Proposed:** under review and not yet a repository contract.
- **Accepted:** the current architectural direction.
- **Superseded:** retained for history and linked to its replacement.
- **Deprecated:** still present for compatibility but must not be extended.

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-audio-identity.md) | Accepted | Typed decoded-audio identity; untyped catalogs unsupported |
| [0002](0002-artifact-generations.md) | Accepted | Timestamped generations, stable symlinks, and full-hash leaves |
| [0003](0003-web-catalog-projection.md) | Accepted | CSV ingest ownership and PostgreSQL serving projection |
| [0004](0004-system-boundaries.md) | Accepted | Python, web, jobs, and backend responsibility boundaries |

When a decision changes, add a new ADR and mark the old record superseded. Do
not rewrite old context to make it appear that the new design always existed.
