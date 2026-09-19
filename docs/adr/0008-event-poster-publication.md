# ADR 0008: Versioned event posters and publication

- **Status:** Proposed
- **Date:** 2026-09-19
- **Canonical references:** [Catalog permission model](0005-catalog-permission-model.md), [Web catalog serving projection](0003-web-catalog-projection.md), [Web security](../web/security.md#access-control), [Offline mode](../web/offline.md)

## Context

An event poster is editorial material shown with an event recording. It has two
display variants:

- a square image for phones, including phones in landscape; and
- a landscape image for desktop and landscape tablets.

The current implementation has already moved its live route and storage helper
from recording hashes to event IDs. A migration script also exists for moving
the poster of an event's primary recording into the event directory. That part
of the direction is correct: a poster describes the event, not one recording
of it.

The rest of the implementation still has the shape of a single mutable
recording attachment:

- one fixed `poster_portrait.*` and one fixed `poster_landscape.*` file are
  stored for an event, with metadata in `poster_meta.json`;
- an upload overwrites the existing file and a delete removes it, so there is
  no candidate history or rollback;
- there is no poster publication state: anyone who may see the event receives
  whichever files currently exist;
- `LISTENER` reads are limited to released, visible events, but every higher
  legacy access level can read the current poster of an unreleased event;
- upload and removal are both OWNER/admin operations through the broad catalog
  management gate; upload and publication cannot be delegated separately;
- the event page calls the small-screen asset `portrait`, renders it as 9:16,
  and switches to landscape at the `sm` width breakpoint rather than by the
  intended device/orientation behavior;
- the poster is inserted after the audio player, not above it; and
- an offline event download prefers the landscape file on every device.

The existing file names do not reliably describe the image content. A local
inventory contains landscape images under `poster_portrait`, a square image
under `poster_landscape`, and duplicate landscape images under both names.
Migration therefore cannot safely relabel or crop files based only on their
names.

The web endpoints are REST-shaped today, but they authenticate with the browser
session cookie and mutation-source/CSRF checks. They are not a supported
external automation API. The existing OAuth tokens are audience-bound to the
MCP protected resource and must not simply be accepted by unrelated REST
routes.

## Decision

### The aggregate is an event poster candidate

A **poster candidate** belongs to one event and contains exactly two assets:
`square` and `landscape`. The pair is one editorial proposal, not two things
that are published independently.

Candidates are immutable after creation. Correcting either asset creates a new
candidate. An event can retain multiple candidates, and at most one candidate
is selected as its published poster.

Publishing changes only the selected candidate. It does not copy, rename, or
overwrite image payloads. Unpublishing clears the selection and leaves all
candidates available to the editorial team. Selecting a previous candidate is
therefore also the rollback mechanism.

Poster publication is independent of event release:

- a candidate may be selected before its event is released;
- ordinary users still cannot obtain it until they may see the event; and
- unpublishing a poster does not unrelease the event or affect its audio.

This keeps event preparation possible without creating an ordering dependency
between two editorial workflows.

### PostgreSQL stores identity and publication; the filesystem stores bytes

Add an authoritative relational row for each candidate and a separate current
publication row.

The conceptual schema is:

```text
CatalogEventPoster
  id
  workflowGroupId + eventId       -- owning event
  label                           -- optional human label
  square metadata                 -- extension, byte size, digest
  landscape metadata              -- extension, byte size, digest
  createdById + createdAt

CatalogEventPosterPublication
  workflowGroupId + eventId       -- primary key; zero or one per event
  posterId                        -- composite FK must belong to that event
  publishedById + publishedAt
```

The actual Prisma relation must constrain `posterId`, `eventId`, and
`workflowGroupId` together, so a candidate from one event cannot be selected
for another by a faulty caller. Unpublish history belongs in the audit log;
the publication row represents only current state.

Image payloads remain below the server-controlled poster root, consistent with
ADR 0003:

```text
posters_<catalog-id>/events/<event-id>/<poster-id>/square.<ext>
posters_<catalog-id>/events/<event-id>/<poster-id>/landscape.<ext>
```

Clients never send or receive filesystem paths. The server derives them from
validated catalog, event, candidate, and extension data.

An upload is processed into a temporary directory on the same filesystem and
renamed to the final immutable candidate directory only after both assets pass
validation. The database row is created only after that rename. A failed
database insert may leave an unreferenced directory, which a health/cleanup
command can report and remove; a database row must never intentionally point
at a partially written candidate.

### Asset contract

Use the names `square` and `landscape` throughout new UI, API, database, and
storage code. Do not continue `portrait` as an alias in the new data model.

New candidates require both assets in the same multipart request. The server
continues to:

- accept JPEG and PNG only;
- verify decoded content rather than trusting the filename or MIME type;
- apply EXIF rotation;
- enforce byte and decoded-pixel limits; and
- bound output dimensions.

It also validates the intended aspect ratios with a small documented tolerance:
1:1 for square and 16:9 for landscape. It must reject a mismatched asset rather
than silently crop designed content. The management UI shows the required
ratio and previews each image inside the exact target frame.

### Publication and permissions

"Everyone can see a published poster" means every authenticated actor who may
see its event. It does not make catalog posters public on the Internet and it
does not widen event visibility.

Under ADR 0005's permission-set model:

| Operation | Required authority |
| --- | --- |
| Read the selected poster | Permission to view the event |
| List or preview unpublished candidates | Permission to view the event, plus `see_unreleased`, `manage_event_posters`, or `publish_event_posters` |
| Create and delete an unselected candidate | Permission to view the event, plus `manage_event_posters` |
| Select, replace, or unpublish the selected candidate | Permission to view the event, plus `publish_event_posters` |
| Delete the selected candidate | Never directly; unpublish it first |

`curator` receives both poster permissions and `catalog_admin` receives them
through its wildcard. Lower roles receive neither by default, but a catalog
administrator may add either permission to a named account. Giving upload
permission does not implicitly give publication permission, and neither poster
permission bypasses the event's released/unreleased visibility scope.

ADR 0005 is implemented, so route code asks these poster-specific permissions
directly. The legacy access-level compatibility mapping gives both mutation
permissions to `OWNER`; role-native grants use the role and additive permission
sets above.

Successful candidate creation, deletion, publication, replacement, and
unpublication are audit events with actor, catalog, event, and candidate IDs.
Add `EVENT_POSTER_CREATED`, `EVENT_POSTER_DELETED`,
`EVENT_POSTER_PUBLISHED`, and `EVENT_POSTER_UNPUBLISHED` audit actions; a
replacement is one publish event containing both the old and new candidate IDs.
Denied writes continue to be audited. Reads need no new per-image audit event.

### Read and management APIs

Keep an audience-oriented endpoint separate from editorial candidate routes.
The proposed browser-session REST surface is:

```text
GET    /api/catalogs/:catalogId/events/:eventId/poster?variant=square|landscape

GET    /api/catalogs/:catalogId/events/:eventId/posters
POST   /api/catalogs/:catalogId/events/:eventId/posters
GET    /api/catalogs/:catalogId/events/:eventId/posters/:posterId/image?variant=...
DELETE /api/catalogs/:catalogId/events/:eventId/posters/:posterId

PUT    /api/catalogs/:catalogId/events/:eventId/poster-publication
DELETE /api/catalogs/:catalogId/events/:eventId/poster-publication
```

`PUT poster-publication` accepts `{ "posterId": "..." }`. Repeating the same
request is idempotent. Replacement is one database transaction; readers see
the old candidate or the new candidate, never an empty intermediate state.
`DELETE poster-publication` is also idempotent.

The singular audience endpoint resolves only the currently selected candidate
for ordinary readers. Actors with draft visibility use the candidate image
endpoint for previews; the main event page does not accidentally substitute a
draft. A missing selection returns `404`.

Event-detail responses expose only published poster information to ordinary
readers. Draft counts, labels, file metadata, and candidate IDs are returned
only to actors with draft visibility. The event list's poster status becomes
`none`, `draft-only`, `published`, or `published-with-newer-drafts` for the
editorial columns; ordinary list responses need no poster workflow state.

The selected candidate ID is used as the browser cache version. Audience image
responses remain private and revalidatable so publication or unpublication
takes effect on the next server validation. Immutable candidate previews may
remain in the browser's private cache; the management UI still rechecks live
candidate-view authority and stops rendering previews when that authority is
lost.

### Presentation

Add a `beforeAudioPlayer` slot to the shared recording layout and place the
event poster there. Navigation, description, source management, and poster
management controls stay after the player.

Render the poster with one semantic `<picture>` so only the needed asset is
chosen:

- square by default, including phone landscape;
- landscape for viewport widths at least 1024 px; and
- landscape for an oriented landscape viewport at least 768 px wide and 500 px
  high, covering landscape tablets without classifying short landscape phones
  as tablets.

The exact media query is a presentation constant shared with tests. Both
frames have an explicit aspect ratio to prevent layout shift.

Offline download selects the appropriate variant using the same presentation
rule at download time and records the candidate ID and variant with the Blob.
An already downloaded poster remains an intentional snapshot after later
publication changes, just like the rest of an offline event bundle.

### Programmatic control

The route handler, management UI, and automation entry points call one poster
application service. Image validation, storage, relational writes, permission
decisions, and audit payload construction do not live only in a React page or
only in an HTTP handler.

The first automation surface is a host-local TypeScript CLI in the web
subsystem, because the web subsystem owns the database, user-authored event
state, and poster storage. It supports:

```text
posters list      --catalog <id> --event <id> --actor <email-or-id>
posters create    --catalog <id> --event <id> --actor <email-or-id> --square <file> --landscape <file> [--label <text>]
posters publish   --catalog <id> --event <id> --actor <email-or-id> --poster <id>
posters unpublish --catalog <id> --event <id> --actor <email-or-id>
posters delete    --catalog <id> --event <id> --actor <email-or-id> --poster <id>
```

The CLI is a trusted operator tool, not a network authentication mechanism. It
loads the same explicit web environment as existing database scripts, requires
an actor user/email for attribution, applies that actor's live catalog
permissions, and writes the same audit events. Production mutation requires an
explicit production flag and confirmation; list remains read-only. It never
accepts arbitrary destination paths.

Do not add personal API tokens merely for this feature. They would introduce
token creation, hashing, scopes, rotation, revocation, rate limiting, and UI
work while duplicating an OAuth provider already present in the application.

If remote programmatic demand is demonstrated, expose the same REST resources
through a new OAuth protected resource and explicit poster read/write scopes.
Reuse the existing authorization-server infrastructure, but issue tokens with
the REST API audience; do not accept MCP-audience tokens. A first-party remote
CLI can then use Authorization Code with PKCE and a loopback redirect. Truly
unattended automation would need a separately reviewed service-account or
client-credentials design; an interactive user token must not be presented as
that solution. Remote authentication is a later project, not part of the poster
data model or its first delivery.

## Migration

1. Add the relational candidate/publication schema and poster-specific typed
   capabilities without changing the current reader path.
2. Run a read-only inventory that reports every event/legacy directory, actual
   dimensions and aspect ratio, missing partner asset, duplicate pair, orphan,
   and ambiguous recording-to-event mapping.
3. For each valid square/landscape pair, create one immutable candidate and
   select it so currently visible posters stay visible.
4. Do not infer shape from `portrait`/`landscape` filenames. Ambiguous or
   incomplete material remains in a reported legacy holding area until an
   editor classifies or replaces it. Do not center-crop it automatically.
5. Switch reads, event detail, event list, offline download, and management UI
   to candidates and publication.
6. Verify database/filesystem parity and responsive behavior, then remove the
   fixed-file write path. Retain the old migration only as documented historical
   tooling or replace it with the new idempotent import command.

The migration uses an import label plus both normalized asset hashes so a retry
can recognize a candidate created before an interrupted publication step and
finish publishing it. A label match alone is never sufficient. A retry never
replaces an existing publication, and ambiguous matching candidates are
reported and skipped instead of aborting the whole import. It refuses to add a
legacy candidate when unrelated candidates already exist. It starts with
`--dry-run`; any cleanup is a separate, explicit operation after backup
verification.

## Alternatives considered

### Keep fixed files and add `published: true|false`

This is the smallest schema change, but uploading a new draft would still
overwrite the image the audience is using. Keeping numbered backup files would
recreate candidate identity and a publication pointer informally, with weaker
constraints. Rejected.

### Keep all state in `poster_meta.json` and publish through a symlink

This avoids database tables but makes authorization summaries, event-list
status, audit attribution, concurrent publication, and cross-event integrity
filesystem concerns. It also gives the database no authoritative relationship
between user-authored events and their current poster. Rejected.

### Publish square and landscape independently

This permits mixed campaigns and ambiguous rollback: a phone could see one
proposal while desktop sees another. The pair is one editorial decision, so it
is published atomically. Rejected.

### Add a shared bearer secret or personal access tokens now

A deployment-wide secret has excessive authority and poor attribution;
personal tokens create a second authentication product. The local CLI covers
the immediate automation case, and audience-bound OAuth is the later remote
path. Rejected for the first delivery.

## Consequences

- Upload no longer changes what ordinary users see; publication is deliberate.
- Multiple proposals, rollback, and unpublish are native rather than file
  recovery operations.
- Poster bytes remain easy to back up as files while authoritative editorial
  state becomes queryable and constrained in PostgreSQL.
- Two poster permissions and new audit actions are required.
- New candidates require two correctly shaped inputs; the server does not
  provide a crop editor in the first delivery.
- Database/filesystem writes cannot be one transaction, so health reporting and
  orphan cleanup are part of the operational contract.
- Current mislabeled or incomplete assets require a one-time editorial decision
  instead of an unsafe automatic migration.
- Remote REST automation remains deferred until its authentication need is
  concrete; the service boundary and local CLI keep that addition small later.
