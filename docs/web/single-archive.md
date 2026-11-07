# Deployment archive binding

This is the configuration prerequisite for the
[single-archive rollout](https://github.com/lukleh/besedy/pull/478).
It does not migrate memberships, invitations, source identifiers or artifact
paths. The existing `workflow_group` row remains the source binding.

## Transitional activation

`BESEDY_ARCHIVE_ID` names one existing active source using its
`YYYYMMDD_HHMMSS` ID. The ID is owned by deployment configuration. Requests,
user preferences, global defaults and source recency cannot override it.

For this prerequisite release only, an unset or blank value retains the
current runtime. A configured value activates the binding immediately:

- Public catalog access and discovery are scoped to the selected source while
  existing actor, role, material and revocation checks remain authoritative.
- Startup/admin synchronization and browser ingestion refuse other sources.
  Existing upload operations and worker callbacks also check the intake's source.
- New catalog creation/discovery and deactivation of the bound source are refused.
- The jobs facade and direct ingest/removal/correction flow path resolution
  refuse foreign source IDs before submitting work or resolving artifact paths.
- Malformed configuration fails explicitly. A nonexistent or inactive web
  source fails requests and readiness with no alternate-source fallback.

The required `requireArchive()` resolver rejects an absent binding too. Website
navigation and `GET /api/archive` use it: configure the source before deploying
the client cutover. They never fall back to saved/default/recent catalogs.
The temporary unconfigured server/job path remains only for the staged migration
and must be removed after all consumers and environments have moved. Do not add
a second feature flag or infer an ID from the database.

The website has one archive-settings entry instead of catalog discovery and
creation controls. Browser uploads use the server-selected archive without a
catalog picker. Source IDs remain in existing URLs and download snapshots;
unknown IDs are not rewritten onto the archive. Display settings still use
`/api/preferences`, whose API no longer accepts an active-catalog selection.

## Membership uses existing source grants

When a binding is configured, an ordinary active account may enter the portal
only if its existing `catalog_access` row for that source is `ACTIVE`. An active
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
grant permissions to those accounts automatically. An unset binding retains the
prerequisite release's transitional behavior until the client cutover requires
configuration.

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
4. Complete the remaining invitation/application cutovers in their reviewed PRs;
   any required schema changes follow the documented migration procedure. Keep
   source IDs in correction provenance, downloads, queued jobs,
   search scope and timestamped artifacts. Preserve identities and audit history.

The general CLI pipeline remains able to process explicitly named catalogs.
Only the deployment's web/job entry points are bound here. The host jobs API
and worker validate the configured ID and request match; database existence and
active state are validated by the web application, so their environment must
match the web binding before activation.
