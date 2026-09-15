# Permission Rework Progress

> **Last Updated:** 2026-09-15

Order and state for the rework decided in
[ADR 0005](../adr/0005-catalog-permission-model.md) and
[ADR 0007](../adr/0007-per-catalog-lookups.md). Those records hold the
decisions and the reasoning; this one holds only what has shipped, what is next,
and what must not move. Update a step's state in the same pull request that
changes it. Delete this file when the rework is finished — it is a plan, not a
reference.

## Steps

| # | Step | State |
| --- | --- | --- |
| 1 | Visibility threshold asked as an ordering, not equality with `LISTENER` | In review — [#109](https://github.com/lukleh/besedy/pull/109) |
| 2 | Lookups become per catalog: schema, data, `/api/metadata/*` scoped to the catalog | Not started |
| 3 | Permission checks computed from the level scale inside the policy layer; nothing stored changes | Not started |
| 4 | Roles and extras stored: `CatalogAccess` gains the six role identifiers and an extras list, the roles are defined in code, the five legacy values stay valid | Not started |
| 5 | Roles assigned: 77 listeners, one reader, two hosts with `download_transcripts` as an extra; legacy values retired | Not started |
| 6 | Catalog settings page split into separately gated cards | Not started |
| 7 | Bulk export scoped by the delivery rule; deep-search worker stops passing `accessLevel: null` | Not started |
| 8 | `see_transcript_variants` and `see_speakers` to `catalog_admin`; stream viewer stops being the default view | Not started |
| 9 | `browse_recordings` becomes a stated choice rather than an accident of the tab switcher | Not started |
| 10 | Original-audio download behind the `catalog_admin` wildcard; transcript download gains its pre-correction variant | Not started |

Step 1 comes first because every later step that adds a role depends on it:
while the threshold is an equality with `LISTENER`, a new role below `VIEWER`
would silently gain sight of unreleased material.

Step 2 stands alone and blocks nothing. It is placed early only so that
`manage_lookups` reaches its final shape during step 4 instead of passing
through an interim where one permission stays system-level while every other one
is catalog-scoped. Moving it later costs nothing but that.

Steps 3 and 4 must not change behaviour. Step 3 is a refactor inside the policy
layer: `accessLevelAtLeast` calls become permission checks computed from the
level each account still holds, and the typed capability objects above keep
their shape and their field names. Nothing stored changes. Step 4 is the schema
and the code definitions: `CatalogAccess.accessLevel` widens to hold the six
role identifiers alongside the five legacy values, an extras list is added
beside it, and the roles are defined in code. Nobody is assigned a role yet, so
every account still resolves through its legacy level. If anything visible
changes in step 3 or 4, something is wrong.

Step 5 is where behaviour deliberately does change, for three accounts, and it
is the step that needs the `host` role and the extras column to exist. Keeping
it separate from steps 3 and 4 is what makes those two provable.

## Must not move

**The release gate does not ship with this rework.** Reading a transcript may
only depend on release once corrections exist, because until then nothing can be
released and `read_transcripts` would resolve to nothing. Measured against
production that would take transcripts from one account today, and from all 77
listeners the moment they are made readers. Until corrections exist,
`read_transcripts` means what it means now: read the transcript. Making the
listeners readers is a separate condition with its own bar — the correction
system tried and trusted — and it constrains the promotion, not the gate.

## Waiting on a decision, not on code

None of these blocks any step above.

- The correction data model — spans, attestations and the edit log — is not in
  [ADR 0006](../adr/0006-transcript-correction.md).
- The editorial convention correctors follow. ADR 0006 makes it a prerequisite
  for the correction tool, not for this rework.
- The two questions still open at the end of ADR 0006.
