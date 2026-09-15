# ADR 0007: Per-catalog metadata lookups

- **Status:** Proposed
- **Date:** 2026-09-15
- **Canonical references:** [Web data and database](../web/data-and-database.md#catalog-data-model), [ADR 0005](0005-catalog-permission-model.md)

## Context

`Recorder`, `Location` and `Album` are global tables keyed by a unique name.
Everything that references them is catalog-scoped: `AudioMetadata` through
`workflowGroupId` plus `audioHash`, and `CatalogEvent` through `locationId`.

Three consequences follow from that mismatch.

Write access is not catalog-scoped at all. Every mutating `/api/metadata/*`
route guards with `requireEditorOnAnyCatalog`, which means an editor on *any one*
catalog may edit or delete rows that every catalog depends on. The matching item
reads require only authentication.

Reads are not scoped either. The collection routes scope the usage `_count` but
return the rows themselves unfiltered, so a catalog's recorder and location
pickers offer every value any catalog has ever used.

And the permission cannot be placed. [ADR 0005](0005-catalog-permission-model.md)
gives every catalog permission to a role, but a global table cannot be governed
by a per-catalog role, so `manage_lookups` has nowhere to sit.

## Decision

Lookups belong to one catalog. `Recorder`, `Location` and `Album` gain a
catalog, and their unique constraint moves from the name to the pair of catalog
and name.

### Copies, not links

Each catalog receives a **copy** of exactly the rows referenced from it — through
`audio_metadata` for all three kinds, and additionally through
`catalog_event.location_id` for locations. Rows that nothing references are
parked in the default catalog rather than dropped, so a name somebody typed is
never silently lost.

Copying every row into every catalog would reproduce today's undifferentiated
lists once per catalog, which is the situation the change exists to end.

### Identifiers survive the migration

Lookup ids leave the system: MCP returns them from `list_locations` and
`list_recorders` and accepts them back as search filters, so a client that
remembered one across sessions would stop resolving it. Nothing inside Besedy
persists them beyond the foreign keys the migration repoints — the deep-search
job payload carries a query, instructions and two opaque configuration objects,
not filters.

That makes the case for stability thinner than it first appears, but preserving
ids costs nothing, so the migration keeps each original row and assigns it to one
catalog, creating new rows only for the additional catalogs.

### The invariant

Every lookup reference points at a row in the referencing row's own catalog.
A foreign key cannot express this, so it is a workflow invariant, enforced in
the application and checkable with one query over `audio_metadata` and
`catalog_event`.

## Consequences

- Measured against production on 2026-09-15 the copy rule degenerates to a
  backfill. There is **one** catalog, so every row is assigned to it, nothing is
  duplicated and no id changes. The rule above is what keeps the migration
  correct if a second catalog ever exists; today the change costs a column, a
  backfill and two altered unique constraints.
- `requireEditorOnAnyCatalog` disappears, and with it the `/api/metadata/*` item
  routes that apply no catalog scope at all.
- Removing it reaches further than the guard. The derived flag
  `hasEditorOnAnyCatalog` is computed in `lib/access/capabilities.ts`, shipped to
  the browser by `/api/me/permissions`, consumed by `hooks/use-admin-status.ts`
  and used to gate `admin/metadata/layout.tsx`. Retiring the guard therefore
  changes the shape of a client-facing response, not only server-side policy.
- The change is visible to users, not merely structural: recorder, location and
  album pickers narrow to the catalog being worked on. It therefore needs its own
  tests rather than passing as a migration.
- `manage_lookups` becomes an ordinary catalog permission and joins the
  `redaktor` role, which is where [ADR 0005](0005-catalog-permission-model.md)
  already places it.
- This change is a prerequisite for nothing. `requireEditorOnAnyCatalog` appears
  only in `lib/api/crud-factory.ts`, and the flag derived from it only in the four
  files named above, so it touches no transcript, event, recording or access
  path. It can land before the permission rework, after it, or not yet.
- Landing it **before** the permission rework is nonetheless preferable. The
  rework is a behaviour-preserving refactor, and its safety rests on that
  property; folding a schema-and-data migration into it would cost exactly that.
  Going first also lets `manage_lookups` reach its final shape during the rework
  instead of passing through an interim in which one permission stays
  system-level while every other one is catalog-scoped.
