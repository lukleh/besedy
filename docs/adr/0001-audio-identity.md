# ADR 0001: Decoded-audio identity

- **Status:** Accepted
- **Date:** 2026-07-15
- **Canonical reference:** [Data model](../data-model.md#identifiers-and-terminology)

## Context

Besedy must correlate one recording across source containers, staged audio,
multiple transcription backends, diarization, retrieval indexes, and the web
database. A raw-file digest changes when container metadata changes even though
the speech content is identical.

Historically, catalogs could contain raw-file hashes, and older ingest paths
could use a raw-file digest after decoding failed. That history demonstrated
that a 64-character hexadecimal value alone does not prove which contract
produced it.

## Decision

The canonical recording identity is SHA-256 over decoded signed 16-bit PCM at
16 kHz mono. Filename, source path, ID3 tags, cover art, and other container-only
metadata are outside that identity.

Raw-file digests are not supported as recording identities. The one-time
catalog migration and its temporary tooling have been removed. Any untyped
catalog is unsupported and must be recreated from source audio. A 64-character
value is never silently certified. SHA-256 over source-file bytes may exist
only as private sidecar integrity metadata and cannot enter the catalog `Hash`
column.

A future change to sample format, channel folding, resampling, or hashing
requires a new explicit identity version and transition plan.

## Consequences

- Cataloging requires complete decode and resampling work.
- Equivalent decoded audio in different supported containers normally
  deduplicates.
- Operational search may use unambiguous short prefixes, but persisted joins
  and artifact directories use the complete value.
- Historical fallback behavior is documented here rather than retained as a
  runtime identity mode.
