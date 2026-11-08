# Deployment archive binding

Each deployment serves one explicitly configured archive, following the
[single-archive rollout](https://github.com/lukleh/besedy/pull/478).
The existing `workflow_group` row remains the source binding. Memberships,
source identifiers, authored records and artifact paths are not copied or renamed.

## Required configuration

`BESEDY_ARCHIVE_ID` names one existing active source using its
`YYYYMMDD_HHMMSS` ID. The ID is owned by deployment configuration. Requests,
user preferences, global defaults and source recency cannot override it.

Web and deployment jobs require this value. Missing, blank or malformed
configuration fails closed; there is no unconfigured multi-catalog mode:

- Public archive access is scoped to the selected source while
  existing actor, role, material and revocation checks remain authoritative.
- Startup/admin synchronization and browser ingestion refuse other sources.
  Existing upload operations and worker callbacks also check the intake's source.
- Browser catalog listing, creation, discovery and source deactivation are retired.
- The jobs facade and direct ingest/removal/correction flow path resolution
  refuse foreign source IDs before submitting work or resolving artifact paths.
- Malformed configuration fails explicitly. A nonexistent or inactive web
  source fails requests and readiness with no alternate-source fallback.

The `requireArchive()` resolver validates that the selected web source exists
and is active on every request. Readiness fails when that record is missing or
inactive. Startup sync, transcript-backend discovery, upload progress and lists,
and development user seeding all use that source. Configure it before starting
the application; never infer an ID from preferences, defaults or database order.

The website has one archive-settings entry instead of catalog discovery and
creation controls. Browser uploads use the server-selected archive without a
catalog picker. Source IDs remain in existing URLs and download snapshots;
unknown IDs are not rewritten onto the archive. Display settings still use
`/api/preferences`, whose API no longer accepts an active-catalog selection.
The old catalog list/create/discover and source deactivation APIs are removed.
Source settings retain label and path updates with their existing permission
checks; `isActive` is not an accepted update field. The obsolete default-source
flag and per-user active-source preference have been removed from storage.
Source foreign keys remain available for historical records.

## Registering a source on a new database

Apply the normal migrations first. Before starting the bound application on a
new database, explicitly register its source. `DATABASE_URL` must already point
at the intended database; the command does not load environment files or choose
an environment. Paths refer to the files as seen by the web container, which may
differ from host paths.

```bash
cd web
BESEDY_ARCHIVE_ID=YYYYMMDD_HHMMSS npm run archive:register -- \
  --archived-catalog-path /data/text/catalogs/audio_catalog_YYYYMMDD_HHMMSS_loudness_archived.csv \
  --metadata-catalog-path /data/text/catalogs/audio_catalog_YYYYMMDD_HHMMSS.csv \
  --transcripts-path /data/text/transcripts/transcripts_YYYYMMDD_HHMMSS \
  --label Archive
```

Optional flags are `--label`, `--transcripts-path` and
`--duplicates-catalog-path`. The required metadata and archived paths use the
same field validation as source settings. The source ID comes exclusively from
`BESEDY_ARCHIVE_ID`. Registration performs a create, so an existing ID fails
without rewriting its paths, state, grants or authored data. Use the settings
page for an intentional update to an existing source.

Registration does not open CSVs, synchronize projections or assign content
access. Run the read-only preflight below, then the existing
`npm run catalog:sync -- --group <source-id>` command using the same configuration
and the documented [sync rules](data-and-database.md#sync-rules). An existing
deployment with the selected row needs no registration step. Superadmin
bootstrap remains the separate existing `db:seed` procedure.

## Membership uses existing source grants

An ordinary active account may enter the portal only if its existing
`catalog_access` row for the configured source is `ACTIVE`. An active
or more privileged grant for another source cannot substitute for a missing or
revoked bound grant. Active system administrators and the superadmin bootstrap
retain their existing exception; blocked and pending accounts remain denied.

The existing `(user_id, catalog_id)` unique key already supplies one membership
per person for the selected archive. Keep those rows, their role/extras, actor
and revocation fields, source foreign keys and stable identifiers. Other-source
grants remain historical records; this change neither copies nor unions them.
No new membership table or physical permission migration is needed. Account
identities, authored state and audit evidence survive loss of access.

Before activation, review the preflight's users without access to the selected
source. Resolve any intended grants explicitly; selecting the archive does not
grant permissions to those accounts automatically.

Every ordinary invitation needs a role and authorized extras for that archive.
Acceptance consumes only its bound pending grant and activates the pending
account atomically. Existing other-source grants remain historical records.
Legacy sign-in-only admissions need an explicit role assignment or revocation;
editing their notes never grants access. The per-email administrator-denial
record, blocking and protected-role checks remain authoritative.

## Read-only preflight

Run this against an explicitly selected environment's database, with a candidate
ID in this process's environment. Use the existing database connection procedure
in [data and database](data-and-database.md); the command does not load a
production environment file or select a database automatically.

```bash
cd web
BESEDY_ARCHIVE_ID=<candidate-source-id> npx tsx scripts/archive-preflight.ts
```

`DATABASE_URL` must already point at the intended database. The inventory runs
inside a PostgreSQL read-only, repeatable-read transaction. It does not open
source CSVs, synchronize projections, select a default, change grants or delete
data. The JSON includes all source records/paths, reference counts, publication
counts, memberships and pending grants with their roles/extras/statuses, pending
admissions without access to the candidate, ordinary users without candidate
access, in-flight uploads/jobs, pending/activating/rolling-back publications and
search-withdrawal intents with their index job IDs. Treat account and path data as operator
information rather than public output.

Exit code 1 means configuration failed or the report lists matters requiring
an explicit migration decision. Multiple grants are reported even when their
permissions match; permissions and revoked state are never unioned or promoted.
No preflight result authorizes an automatic merge, grant or deletion.

## Configuration and rollout

1. Review the inventory and resolve retained material, conflicting grants,
   sign-in-only invitations and in-flight jobs before cutover.
2. Set the same source ID in the selected web env file, matching jobs env file,
   and host worker environment. Keep development, test and production resources
   isolated. The Docker wrappers forward the value from their resolved env
   files; a shell preference does not select the web archive.
3. Restart the matching services through their existing deployment procedures.
   Verify web readiness and ordinary user/admin access. No production ID is
   supplied by this change; choosing it is an operator action after preflight.
4. Keep source IDs in correction provenance, downloads, queued jobs, search scope
   and timestamped artifacts. This cutover needs no new membership table or
   permission-copy migration. Any later physical schema cleanup follows the
   documented migration procedure after its rollback window is reviewed.

The general CLI pipeline remains able to process explicitly named catalogs.
Only the deployment's web/job entry points are bound here. The host jobs API
and worker validate the configured ID and request match; database existence and
active state are validated by the web application, so their environment must
match the web binding before activation.
