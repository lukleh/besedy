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

| ADR                                      | Status   | Decision                                                                                 |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| [0001](0001-audio-identity.md)           | Accepted | Typed decoded-audio identity; untyped catalogs unsupported                               |
| [0002](0002-artifact-generations.md)     | Accepted | Timestamped generations, stable symlinks, and full-hash leaves                           |
| [0003](0003-web-catalog-projection.md)   | Accepted | CSV ingest ownership and PostgreSQL serving projection                                   |
| [0004](0004-system-boundaries.md)        | Accepted | Python, web, jobs, and backend responsibility boundaries                                 |
| [0005](0005-catalog-permission-model.md) | Accepted | Permission sets with visibility as one permission, roles as named presets                |
| [0006](0006-transcript-correction.md)    | Proposed | Human transcript correction as a time-anchored layer that substitutes for machine output |
| [0007](0007-per-catalog-lookups.md)      | Accepted | Recorder, location and album rows belong to one catalog                                  |
| [0008](0008-web-recording-ingest.md)     | Accepted | Web-triggered recording ingest via a host Prefect worker; duplicates rejected            |
| [0009](0009-event-poster-publication.md) | Accepted | Immutable event-poster candidates with explicit publication and separate upload/publish authority |
| [0010](0010-event-page-draft-poster-preview.md) | Accepted | The event page previews the latest draft poster for actors with draft visibility |
| [0010](0010-poster-to-artwork-rename.md) | Accepted | Rename "poster" to "artwork" ("plakát" to "obálka") across schema, storage, API, and CLI |

When a decision changes, add a new ADR and mark the old record superseded. Do
not rewrite old context to make it appear that the new design always existed.
