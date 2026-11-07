# ADR 0014: One archive and event-focused listening

- **Status:** Accepted product direction; rollout below is planned
- **Date:** 2026-11-07
- **Canonical references:** [Web architecture](../web/architecture.md), [offline playback](../web/offline.md), [recording ingest](../web/recording-ingest.md), [permissions](0005-catalog-permission-model.md), [correction](0006-transcript-correction.md)

## Context

The website grew from recording catalogs into an event archive. It still carries
catalog selection and default resolution, public recording and event surfaces,
and a separate radio playback lifecycle. Offline rendering also reconstructs
catalog browsing, although Downloads already lists the locally available items.

The intended product is now one archive. People browse events, and each event
offers its preferred recording. Playback belongs to the open event page and may
stop when the person leaves it. Radio and multiple website catalogs are retired
features. This decision describes the target; it does not claim that all the
existing implementations have already been removed.

## Decision

### Retained capabilities

- CLI ingestion and browser uploads, with asynchronous processing and recovery.
- Multiple machine transcript variants, model comparison, correction/publication,
  and training from corrected transcripts.
- Search/RAG and MCP access to the corpus.
- Granular roles, delegated capabilities, and authoritative server-side access
  and material-visibility checks.
- Downloads, cached transcripts/artwork where permitted, and uninterrupted
  playback of downloaded audio when connectivity disappears.
- Existing ordinary playback controls, including resume, media controls and the
  sleep timer. Their removal is outside this decision.

### Audience and editorial boundaries

The event is the audience browsing and listening object. Its preferred capture
is the one offered for normal playback. Editors may retain and inspect alternate
captures and select the preferred one. These captures are not assumed to be
consecutive parts of one timeline.

The full decoded-audio hash remains the recording/capture identity used by
transcript variants, correction sources, training examples, bookmarks and saved
positions. Playback/cache keys additionally retain rendition and format identity;
different encoded files do not have identical bytes. An event identity must not
silently substitute a different recording under any of those references.
Existing correction workspaces retain their frozen source even if an editor
changes the event's preferred recording.

The ordinary listener presentation should be reusable for an online event and
its downloaded snapshot. Editorial tools and transcript comparison remain
separate consumers; they need not be embedded as optional modes of the audience
page. A global listener runtime is unnecessary for page-owned playback.

### Offline contract

Downloads is the offline library. Normal catalog browsing, search, editing and
administration require connectivity. A downloaded event can still open at its
event URL and display the permitted local transcript and artwork.

A recording with a complete matching download can play from that local audio
while online. Losing or restoring connectivity must not restart it, change its
position or silently select another capture. If an editor changes the preferred
capture, replacing an existing download is an explicit update of the package.
Existing permission-revocation handling remains authoritative.

Keep the chunked cache, range responses, completion verification, resumable
transfer and the browser-specific audio handling needed for long recordings.
Removing offline catalog browsing does not authorize replacing these mechanisms
with a whole-recording Blob or dropping the AAC delivery path.

### One archive, with explicit source provenance

Each deployment binds the website to one existing pipeline source/catalog ID.
Development, test and production remain isolated deployments. This is a
server-owned binding, not a user preference, a newest-catalog fallback or a
catalog ID accepted from an untrusted request.

Source timestamps, full-hash leaves, transcript language/model identities,
correction paths and index scope identifiers remain intact during the initial
migration. The one source-binding record may remain useful after its cardinality
becomes one. Renaming every artifact tree or dropping every source foreign key
is not required to remove multiple website catalogs.

Website access becomes one archive membership per user, retaining the existing
role, extras, revocation state and audit evidence. MCP tools use that same
archive and continue checking the actor and material on every request.

### Invitations include content access

Every invitation for a non-admin user includes the role and any authorized
extras that define their content access. Accepting the invitation establishes
that access. The target has one invitation flow, with one pending invitation
per normalized email; it has no separate sign-in-only invitation or multi-catalog
sponsorship lifecycle. Ordinary website access requires active membership;
administrator bootstrap remains separate.

Granular roles, protected-role delegation, blocking, revocation and audit
history remain. Revoking access does not delete an identity needed by authored
content or historical records, and an identity record alone grants no access.
Existing sign-in-only invitations need an explicitly assigned role or
cancellation before the invitation cutover; migration must not assign a default
role to make those records valid.

## Pull request sequence

Each row is an independently reviewable change with its own documentation and
verification. The names are scopes, not promises to combine unrelated edits.
The first two implementation rows can proceed independently of data migration.

| PR | Scope and code removed | Depends on | Acceptance evidence |
| --- | --- | --- | --- |
| 1 | Record this decision and rollout | None | Documentation links resolve; implemented behavior and planned changes are distinguished |
| 2 | Remove radio runtime, provider, controls, history, retries and recording handoff; remove radio-only endpoints/helpers after caller checks | None | Ordinary playback/resume, media controls, sleep timer and reload protection pass; no live radio consumers remain |
| 3 | Remove offline catalog lists and their data reconstruction; failed catalog navigation opens Downloads in the offline shell | None | Downloaded event and exact-capture routes still open; cached playback survives network loss/recovery; online browsing is unchanged |
| 4 | Make preferred-capture event listening the audience surface; reuse a listener presentation for online/downloaded events; retain editorial capture inspection | 2, 3 | Audience cannot select alternates; editor can choose/inspect captures; transcript variants and correction access remain; links and seek targets preserve exact audio identity |
| 5 | Add the explicit deployment archive/source binding and a read-only migration preflight; scope startup/admin sync, upload and internal job entry points to it | 1 | Missing, conflicting or invalid binding fails clearly; production/test/dev cannot resolve each other's resources; no default/newest fallback |
| 6 | Remove website catalog selection, active/default preferences, discovery/create/default controls and selection synchronization; retain one source-settings view | 5 | Header/navigation/upload/access management use the bound archive; no preference/default/recent selection chain remains; no database column removal yet |
| 7 | Simplify MCP schemas, access profile and tools to the archive; retire catalog discovery/default selection; update tool docs and corpus skill together | 5 | Authenticated MCP smoke and capability tests pass; citations, pagination cursors and event/seek links resolve correctly |
| 8 | Migrate per-catalog grants into one archive membership while preserving roles/extras/revocation and grant history | 6, 7, reviewed data preflight | Permission matrix is unchanged for migrated members; ambiguous grants require an explicit decision; no automatic union or promotion |
| 9 | Replace separate sign-in-only invitations and multi-catalog sponsorship with one pending invitation per normalized email carrying role/extras | 8, reviewed invitation preflight | Creation and acceptance require authorized content access; accepting establishes membership atomically; blocking/revocation and protected-role/no-self-grant checks remain; history survives |
| 10 | Remove obsolete catalog-selection and invitation schema, APIs and compatibility paths after consumers have moved | 6, 7, 8, 9 | Fresh and upgraded disposable databases pass; source records and authored state survive; no supported client uses retired fields |

PR 4 may need two patches if extracting the shared listening presentation and
switching audience routes cannot be reviewed clearly together. Its scope does
not include moving authored metadata between tables or removing independent
recording-publication state; those require an explicit data mapping and a
separate decision.

The later single-archive PRs should be based on their named prerequisites after
review, rather than mixing source binding, permission changes and table drops
into one migration. The radio and offline-navigation PRs can target main
directly. Reconcile any overlapping playback/offline tests before merging both.

## Migration and verification

Before activating the archive binding, inventory existing source records and
their event, capture, correction, publication, membership, invitation and job
references. Select the intended archive explicitly. If more than one source
contains retained material or conflicting memberships, prepare a reviewed
mapping; do not merge, delete or grant access implicitly. The preflight is
read-only and production inspection is a separate operator action.

The invitation preflight also identifies pending admissions without content
access, conflicting pending grants and existing accounts without active access.
Resolve pending invitations explicitly before cutover. Existing accounts must
not acquire access automatically or lose identity records referenced by content
or audit history.

Keep existing source identifiers in queued jobs, frozen provenance and downloaded
packages until their consumers have a tested migration. Public URL changes may
use small redirects for the known archive. An old recording URL with a seek
position cannot be redirected to a different preferred capture's timeline.
Unknown source IDs must not silently select the archive.

Use the repository's migration creation/deployment procedure. Retain audit and
correction history, and do not use database push/reset against retained data.
Delay destructive schema cleanup until the application cutover and its rollback
window have been reviewed. A new archive-binding schema is not a reason to
rebuild user-authored state from CSVs.

Each code PR runs focused unit coverage plus TypeScript, lint and the relevant
broader web checks. Exercise playback/Downloads changes through the existing
offline and audio tests; include browser coverage for opening a downloaded event,
losing connectivity during playback, reconnecting, resuming, and navigation from
an unavailable catalog to Downloads. Keep production-build E2E isolation.

Archive changes additionally require access/admission and MCP regressions,
catalog projection integration checks, fresh/upgrade migration checks and Compose
rendering when configuration changes. Missing infrastructure must be reported;
an unavailable check is not evidence that the migration is safe.

## Deferred work

Event metadata/release ownership, processing one submitted recording instead of
the whole backlog, on-demand sidecars, and old notification-table retirement are
follow-up candidates. They are outside the first rollout. The required model
variants, correction/training contracts and jobs infrastructure are retained;
this decision does not choose a single recognizer or replace the execution queue.

## Consequences

Two public product dimensions disappear: choosing a catalog and choosing an
alternate recorder capture. A complete secondary playback subsystem disappears
with radio. Offline behavior is centered on prepared event packages and their
listening experience rather than reconstructing the catalog website.

The implementation retains necessary distinctions: authored events versus
replaceable processing projections, exact audio versus mutable event choices,
roles versus source identity, and offline media transport versus browsing. The
rollout pays migration costs only where removing a product behavior requires it.
