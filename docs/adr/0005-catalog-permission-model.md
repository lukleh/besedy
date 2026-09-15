# ADR 0005: Catalog permission model

- **Status:** Proposed
- **Date:** 2026-09-15
- **Canonical references:** [Web security](../web/security.md#access-control), [MCP server](../web/mcp-server.md#access-matrix)

## Context

Catalog authorization is a single ordered scale,
`LISTENER < VIEWER < MEMBER < EDITOR < OWNER`. Gaining a capability requires
moving up the scale, which also widens visibility, because the scale carries two
unrelated concerns at once: *which material exists for an actor* and *what the
actor may do with it*.

Three concrete requirements cannot be expressed on that shape:

1. An account that may add other users to a catalog but must not release events.
   Neither role is above the other, so no ordered scale can hold both.
2. Transcript correction as an activity of its own, held by accounts that are
   otherwise ordinary readers.
3. Granting one capability to a single account without promoting it past
   everything else on the way.

The current shape also produces effects nobody chose. `canUseCatalogTabSwitcher`
requires event-edit rights, so every level below OWNER is locked to the events
view with no path to the recordings list. The bulk transcript export applies no
per-recording publication scoping. The deep-search worker searches with
`accessLevel: null`.

## Decision

### Two values, not one scale

An actor holds, per catalog:

- a **visibility** value: released events and published recordings only, or all
  material;
- a **set of permissions**.

Permissions are the semantics: every gate asks whether a permission is present,
never whether a level is high enough.

### Roles are named permission sets

Roles are defined in code, the way feature rollouts already are. An account
stores a role name per catalog, not an expanded set. Adding a role is a commit,
not a migration and not a runtime editor.

### Extra permissions are additive only

An account may carry extra permissions on top of its role. Extras are added,
never subtracted, so the role name always remains a lower bound on what the
account may do.

Effective permissions = role permissions ∪ extras.

### Listening and reading are the product; file delivery is an exception

Besedy is used by listening to a recording and, optionally, following its
transcript — in the web application, or through an agent asking questions of the
corpus. That is what roles are for.

Taking audio or transcript files out of the application serves specific,
occasional purposes. Those permissions belong to the roles that run the archive —
`redaktor` and `catalogAdmin` — and to **individually named accounts** below
them. No role that describes an ordinary participant carries one.

This splits the catalogue in two: permissions that describe a kind of
participant, and permissions that describe an exception made for one person.

Caching a recording for offline listening is not file delivery. The audio stays
inside the application and the experience is the same one `stream_audio`
describes, so it needs no separate permission.

### One transcript per recording

A recording has exactly one transcript from a reader's point of view: the
corrected one when it exists, the original machine output otherwise. Correction
state is a **substitution**, not a visibility gate. A corrected transcript
replaces the original everywhere it is read — page, download, export, search and
MCP alike.

What a reader is given is the corrected transcript. Where none exists yet the
original stands in, marked as unverified machine output — the difference between
the two is carried by **labelling, not by access**. As correction progresses the
stand-ins are replaced one recording at a time, and nobody's permissions change.

There is therefore no permission for "corrected transcripts" as distinct from
"all transcripts". The original text remains reachable in exactly two places:

- inside the correction surface, as the text being worked on;
- through an explicit download of the pre-correction variant.

### Correction is its own activity

`correct_transcripts` is not an extension of reading. It grants the correction
surface, and access to the original text is part of that surface rather than a
general right to read machine output elsewhere. An account holding
`correct_transcripts` gains nothing in search, download, or MCP.

### Account tiers

| Tier | Scope |
| --- | --- |
| superadmin | Everything. Bootstrap account; not for daily use. |
| admin | Everything. |
| catalogAdmin | Every permission within one catalog, as a wildcard rather than an enumerated set. |
| user | A role, optional extras, and a visibility value per catalog. |

`catalogAdmin` is a wildcard so that new permissions accrue to it automatically
instead of needing to be added to a top role every time.

### Granting rule

An account that may grant permissions may grant:

- visibility no higher than its own;
- a subset of its own effective permissions;
- never `manage_access` itself.

Only `catalogAdmin` and above may grant `manage_access`. This generalizes the
existing rule that an OWNER cannot grant OWNER, which exists to prevent
self-propagating privilege chains, and keeps the tier list load-bearing:
`catalogAdmin` is the tier that can mint accounts which grant.

## Permission catalogue

### Material visibility

| Permission | Covers |
| --- | --- |
| `see_unreleased` | Unreleased events, unpublished and non-actionable recordings, and the release-state indicators that only make sense alongside them. |

### Browsing and audio

| Permission | Covers |
| --- | --- |
| `browse_recordings` | The recordings list as a surface. Today this is an accident of the tab switcher; it becomes a choice. |
| `stream_audio` | Playback, including radio mode and offline caching. |

### Transcripts

| Permission | Covers |
| --- | --- |
| `read_transcripts` | The recording's transcript: corrected when one exists, original otherwise. |
| `see_transcript_variants` | That more than one machine backend exists: the per-recording picker and the multi-backend stream view. Administrative only; every other role reads the default backend. |
| `see_speakers` | The diarization overlay. |

### Correction

| Permission | Covers |
| --- | --- |
| `correct_transcripts` | The correction surface: editing spans, proposing corrections, attesting, and reading the original text within that surface. |
| `publish_transcript` | Marking a transcript as corrected, and resolving disputes between correctors. |

### Search

| Permission | Covers |
| --- | --- |
| `search_transcripts` | Semantic and lexical search over the same transcripts `read_transcripts` serves. |
| `use_deep_search` | Running and reading deep-search jobs. Per-job sharing stays a property of the job. |

### Curated metadata

| Permission | Covers |
| --- | --- |
| `edit_metadata` | Per-recording curated metadata, including the verified flag. |
| `batch_edit_metadata` | Inline bulk editing across the recordings list. |

### Editorial and publication

| Permission | Covers |
| --- | --- |
| `publish_recording` | Recording publication state. |
| `manage_events` | Creating, editing and deleting events; attaching, detaching and choosing the primary recording. |
| `release_events` | Releasing an event to its audience. |
| `manage_event_posters` | Event poster upload and removal. |
| `manage_event_sources` | Event source records. |

### Access and configuration

| Permission | Covers |
| --- | --- |
| `manage_access` | Granting and revoking access, including pending grants for accounts that have never signed in. |
| `manage_lookups` | Recorder, location and album rows for this catalog. |
| `manage_catalog_config` | Catalog paths, sync, default and active flags. `catalogAdmin` only. |

### File delivery — `redaktor` and above, or an individual grant

Held by `redaktor` and `catalogAdmin`. For any role below them these are extras
granted to a named account, and since a granter may only pass on what it holds,
such a grant comes from `catalogAdmin`.

| Permission | Covers |
| --- | --- |
| `download_audio` | The playable audio file. Original masters stay inside the `catalogAdmin` wildcard. |
| `download_transcripts` | File delivery of a recording's transcript. |
| `download_original_transcript` | The pre-correction machine text, as an explicit variant of that download. |
| `bulk_export_transcripts` | Catalog-wide export. The highest-impact permission in the catalogue: one request yields the whole corpus as data. |

### Outside the catalog scope

The admin panel, user management, audit log, MCP usage, transcript backend order
and catalog sync remain system-level rights of `admin` and `superadmin`. No
catalog permission reaches them.

## Roles

| Role | Visibility | Permissions |
| --- | --- | --- |
| posluchač | published | `stream_audio` |
| čtenář | published | + `read_transcripts`, `search_transcripts` |
| korektor | published | čtenář + `correct_transcripts`, `see_speakers` |
| hostitel | published | čtenář + `manage_access` |
| redaktor | all | `browse_recordings`, `stream_audio`, `read_transcripts`, `search_transcripts`, `see_speakers`, `correct_transcripts`, `publish_transcript`, `edit_metadata`, `batch_edit_metadata`, `manage_lookups`, `publish_recording`, `manage_events`, `release_events`, `manage_event_posters`, `manage_event_sources`, `use_deep_search`, and the file-delivery permissions |
| catalogAdmin | all | wildcard, including `see_transcript_variants` and `manage_catalog_config` |

Expected occupancy at introduction: one `catalogAdmin`, two `hostitel` (one of
them with `download_transcripts` as an extra), a few `korektor`, and everyone
else `čtenář`. `redaktor` starts empty — its editorial rights currently sit with
the `catalogAdmin`.

## Consequences

- Transcript correction state becomes a publication flag on the transcript,
  alongside `CatalogEntry.isPublished` and `CatalogEvent.released`. Whether a
  transcript has passed correction is a workflow invariant that permits setting
  the flag, not an authorization decision.
- Because correction substitutes rather than gates, search needs no notion of
  correction state for authorization. It needs the index to be refreshed when a
  transcript changes, which the incremental per-`audio_hash` sync keyed on
  `transcript_fingerprint` already does. This is existing machinery, not new
  index work.
- Substitution has to be resolved in `lib/transcript`, not in one caller.
  `loadTranscript()` serves the recording page, the backend comparison view and
  MCP, while the transcript download route and the bulk export read format
  files through `readTranscriptFile()`. Both readers must resolve "corrected if
  present, original otherwise", or downloads and the export keep serving machine
  text after the page has switched.
- MCP serves the same substituted transcript. The documented decision that a
  listener may read transcripts through MCP stops conflicting with web
  restrictions, because both surfaces now serve one text.
- The catalog settings page is one permission today and mixes access management,
  catalog configuration, event health and bulk transcript export. Splitting the
  roles requires splitting that page into separately gated cards.
- `requiresReadyRecordingScope` and `requiresReleasedEventVisibilityScope` test
  equality against `LISTENER`. They must become visibility checks before any new
  role is introduced, or the new role silently gains full visibility.
- The bulk export path and the deep-search worker currently bypass publication
  scoping. Both have to consult visibility like every other read.
- The recording page's "download original audio" item moves behind the
  `catalogAdmin` wildcard, and the transcript download route gains a variant
  parameter for the pre-correction text.
- Download controls disappear for almost every account. Today `MEMBER` and above
  see them; afterwards only accounts holding an explicit extra do. This is a
  visible product change, not only a policy one.
- A download permission bounds **file delivery, not text extraction.** A reader
  can copy a whole transcript from the page, and an agent asked for the full text
  through MCP can hand it over. If the goal is to control who holds the corpus as
  data rather than who gets a convenient button, download permissions alone do
  not achieve it.
- The lookup change splits in two, and the halves belong to different tasks. The
  **schema and data** half — `Recorder`, `Location` and `Album` gain a catalog,
  their unique constraints become per-catalog, and the `/api/metadata/*` routes
  become catalog-scoped — stands alone and may land first. The **permission**
  half, where `manage_lookups` becomes a catalog permission and joins `redaktor`,
  belongs to the permission rework.
- Lookups are copied per catalog, not shared. Each catalog receives a copy of
  exactly the rows referenced from it, through `audio_metadata` for all three
  kinds and additionally through `catalog_event.location_id` for locations.
  Copying every row into every catalog would reproduce today's undifferentiated
  lists once per catalog, which is what the change exists to stop. Rows nothing
  references are parked in the default catalog rather than dropped.
- Lookup ids leave the system: MCP returns them and deep-search jobs store them
  in saved metadata filters. The migration therefore keeps each original row and
  assigns it to one catalog, creating new rows only for the others, so most ids
  stay stable and saved filters keep resolving.
- Measured against production on 2026-09-15 the copy rule degenerates to a
  backfill: there is **one** catalog, so every lookup row is assigned to it, no
  row is duplicated and no id changes. The rule above is what makes the migration
  correct if a second catalog ever exists; today it costs a column, a backfill
  and two changed unique constraints.
- The resulting invariant — every lookup reference points at a row in the
  referencing row's own catalog — cannot be expressed as a foreign key. It
  belongs with the workflow invariants rather than with authorization.
- Doing the data half first means `manage_lookups` reaches its final shape during
  the rework instead of passing through an interim in which one permission stays
  system-level while every other one is catalog-scoped.
- The lookup change is not a prerequisite for anything else.
  `requireEditorOnAnyCatalog` appears only in `lib/api/crud-factory.ts` and
  `admin/metadata/layout.tsx`, so it touches no transcript, event, recording or
  access path. Coupling a schema-and-data migration into the behaviour-preserving
  refactor would cost that refactor the property that makes it safe; running it
  before, as its own change, does not.
- Migration is behaviour-preserving: the five existing levels become the first
  rows of the role table, `accessLevelAtLeast` calls become permission checks,
  and only afterwards are `korektor` and `hostitel` added.

## Settled points

- **Unreleased material stops at `redaktor`.** An event cannot be released by
  someone who cannot see it, so `redaktor` holds both `see_unreleased` and
  `release_events`. In practice "unreleased material is for administrators only"
  means `redaktor` and `catalogAdmin`; every role below them loses visibility it
  has today.
- **An empty corrected-transcript state is acceptable at launch.** Until a
  recording has a corrected transcript, readers get the original. No backfill and
  no grandfathering are needed, because substitution makes the original the
  default rather than a withheld variant.
- **Listeners become readers only once the correction system has been tried and
  trusted** — not once it merely exists, and not once the corpus is corrected.
  Until then the 77 `LISTENER` grants measured in production stay as they are,
  which makes every step of this rework invisible to all but three accounts.
- **Provisional text is labelled, not withheld.** A `čtenář` opening a recording
  nobody has corrected yet sees the machine transcript marked as unverified,
  rather than an empty panel. This is the web counterpart of the caution the MCP
  server already asks agents to give, and it is what lets "readers read corrected
  transcripts" and "use the original when there is no corrected one" both hold
  without a second read permission.
- **Backend variants are administrative.** Every role except `catalogAdmin` reads
  one transcript per recording, the configured default from
  `TranscriptBackendPriority`. The picker and the stream view are one permission.
- **Posters and sources stay separate permissions.**
- **Downloaded audio is the playable file.** Original masters are not part of any
  role.
- **File delivery starts at `redaktor`.** No role describing an ordinary
  participant carries a download; below `redaktor` it is granted to a named
  account, because the product is listening and reading inside Besedy.
- **Lookups become per-catalog.** Recorder, location and album rows belong to one
  catalog, which turns `manage_lookups` into an ordinary catalog permission and
  removes the cross-catalog write path that `requireEditorOnAnyCatalog` opens
  today.
