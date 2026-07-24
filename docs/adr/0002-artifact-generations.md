# ADR 0002: Artifact generations and stable pointers

- **Status:** Accepted
- **Date:** 2026-07-15
- **Canonical references:** [Data model](../data-model.md#storage-layout), [development patterns](../patterns.md#cli-output)

## Context

Catalog, audio-preparation, transcript, diarization, and retrieval outputs are
produced at different times and may need rollback or comparison. Overwriting a
single directory would make provenance and recovery ambiguous.

## Decision

Output-producing workflows create timestamped generations derived from the
upstream artifact. Stable, relative symlinks such as `transcripts/` point to the
active generation.

Within a transcript generation, the layout is:

```text
<workflow>/<output-component>/<full-audio-hash>/transcript.json
```

The output component records model, strategy, VAD/alignment, and language
identity. The leaf uses the full 64-character audio hash; abbreviations are a
display and search convenience only.

## Consequences

- Generations can coexist and be inspected or rolled back.
- Commands must derive timestamps from their input chain and validate alignment.
- Stable pointers are mutable coordination state, while generation contents are
  treated as published artifacts.
- Compatibility readers may recognize historical names, but new writers follow
  the canonical layout.
