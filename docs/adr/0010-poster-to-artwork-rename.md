# ADR 0010: Rename "poster" to "artwork" (Czech: "obálka")

- **Status:** Accepted
- **Date:** 2026-09-20
- **Canonical references:** [Versioned event posters and publication](0009-event-poster-publication.md)

## Context

ADR 0009 named this concept "poster." It is not a poster in the print sense —
it is cover art for a recording/event, the same kind of asset a podcast or
album calls its "artwork." "Poster" reads as a promotional print, which is not
what candidates, publication, or the presentation rules in ADR 0009 describe.

The Czech UI used "plakát" (poster), which carries the same mismatch and is
grammatically masculine.

## Decision

Rename the concept, everywhere it appears, without changing the architecture
ADR 0009 established:

- English: "poster" → "artwork".
- Czech: "plakát" → "obálka" (feminine — every Czech string was rewritten for
  gender agreement, not word-substituted; e.g. "Plakát byl zveřejněn" →
  "Obálka byla zveřejněna").
- Prisma models `CatalogEventPoster` / `CatalogEventPosterPublication` →
  `CatalogEventArtwork` / `CatalogEventArtworkPublication`; tables
  `catalog_event_poster(_publication)` → `catalog_event_artwork(_publication)`;
  column `poster_id` → `artwork_id`.
- `AuditAction` enum values `EVENT_POSTER_*` → `EVENT_ARTWORK_*`, renamed in
  place (`ALTER TYPE ... RENAME VALUE`) so existing audit rows keep their
  meaning.
- Permissions `manage_event_posters` / `publish_event_posters` →
  `manage_event_artwork` / `publish_event_artwork` (singular — "artwork" is
  normally a mass noun, unlike the countable "posters" it replaces). Existing
  grants are rewritten in the same migration, not reissued.
- API routes `/poster`, `/posters`, `/poster-publication` → `/artwork`,
  `/artworks`, `/artwork-publication`; page route `.../event/[eventId]/poster`
  → `.../artwork`. No external or mobile consumer calls these routes, so this
  is a clean-break rename with no redirect or alias.
- On-disk layout `posters_<catalogId>/events/<eventId>/<id>/{square,landscape}`
  → `artwork_<catalogId>/...`; env var `POSTERS_DIR` / TOML `posters_dir` →
  `ARTWORK_DIR` / `artwork_dir`.
- CLI `web/scripts/posters.ts` (`just posters`) → `web/scripts/artwork.ts`
  (`just artwork`).
- Deleted (not renamed): ~30 `recording.poster*` i18n keys and
  `catalog.filters.*Posters*` keys left over from an earlier single-image
  upload UI that ADR 0009 already superseded, with zero remaining consumers.

Everything ADR 0009 decided about candidates, publication, permissions,
presentation, and the local CLI's authority model still applies under the new
names; this ADR only retires "poster" as the name for it.

## Migration

This lands after ADR 0009's production cutover (2026-09-19), so real rows and
files exist. One hand-written migration
(`20260920160000_rename_event_poster_to_artwork`) renames tables, the column,
constraints, indexes, and the enum values in place, and rewrites the
`extra_permissions` arrays and audit `resource`/`subject_type`/`details`
values that separately encode `event_poster` as data rather than as a name
Prisma tracks. A companion script, `scripts/migrate-artwork-storage.ts`, does
the equivalent one-level directory rename on disk. Both are idempotent and run
inside the same deploy downtime window as the migration, filesystem first (no
transactional rollback there, so a failure there aborts before any schema
change).

ADR 0009 also named a pending follow-up cleanup (retiring the `inventory` and
`import-legacy` CLI subcommands and the poster branch of
`migrate-recording-assets-to-events.ts`). That cleanup is independent of this
rename and still outstanding; expect its diff to need re-basing over the new
names once it lands.

## Consequences

- No behavior changes; every rename here is 1:1 with ADR 0009's design.
- The one-time storage and database migrations must be sequenced together at
  deploy time, in the same downtime window `just prod-apply` already uses.
- Anyone with a bookmarked `/poster`-family URL or a script hard-coding the
  old permission strings needs to update it; none were found in this
  repository outside the app itself.
