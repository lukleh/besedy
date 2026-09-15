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

### One set of permissions, not one scale

An actor holds, per catalog, a **set of permissions**. Visibility is one of
them: `see_unreleased` widens what exists for the actor from released events and
published recordings to all material. It is not a separate value and not a
position on a ladder, so gaining a capability never widens visibility and
widening visibility never grants a capability.

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

**This is a stance about what the product is, not a control boundary, and it
should not be mistaken for one.** A reader can select and copy a whole
transcript from the page, and an agent asked for the full text through MCP will
hand it over. Offline caching writes the audio bytes to the viewer's device,
where they sit in browser storage; what it withholds is a file the viewer can
easily use elsewhere, which is a matter of convenience rather than of
protection. Anyone determined to hold the corpus as data already can. What these
permissions decide is whether taking files out is a normal part of using Besedy
or an arrangement made with a particular person.

Because it is a stance rather than a control, the cost of holding it should be
counted honestly — and measured against production it is small. Of eighty
grants, seventy-seven are listeners who never had a download; two owners and one
member did. The buttons disappear for three accounts.

Offline caching therefore needs no permission of its own. It delivers bytes, but
it delivers the same listening `stream_audio` already describes.

### The span is the unit of work; the transcript is the unit of release

Correction proceeds span by span and improves the corpus continuously. Reading a
transcript from end to end is a different act, and it opens only when the whole
transcript has been checked and **released**.

Those two facts are not in tension; they answer different questions. What a
correction changes immediately is the material that search and agents draw on,
which gets better one span at a time and needs no ceremony. What a release
changes is whether a person may sit down and read the transcript as a document,
which is an editorial statement about the whole of it and cannot be made span by
span.

So a transcript carries a release state, the third instance of a pattern this
system already uses twice: a recording is published, an event is released, and
now a transcript is released. In each case the state belongs to the material, not
to the actor, and in each case a workflow invariant permits it — an event needs
exactly one primary recording, and a transcript needs every span verified.
Releasing is then a deliberate act by a person, not an automatic consequence of
the last attestation landing.

There is therefore still no permission for "corrected transcripts" as distinct
from "all transcripts". A `čtenář` holds `read_transcripts` and reads released
transcripts, exactly as they browse released events. Unchecked text stays
reachable in the places where working on it is the point:

- inside the correction surface, which `correct_transcripts` grants;
- to `redaktor` and `catalogAdmin` through `see_unreleased`;
- through search and agents, which are not reading surfaces — see below.

### Search and agents are not gated on release

A correction reaches retrieval as soon as it is made; a release gates only the
reading surfaces — the transcript view, its download, and the bulk export.
Search, both in the web application and through MCP, keeps working over whatever
text exists and simply gets better as correction proceeds.

This is deliberate and it follows a decision the MCP server already records: the
web transcript view hands a person the full text to read like a book, while
through MCP the transcript is background an agent draws on while answering a
question. Because `get_transcript` can return a full transcript, a reader can
obtain unreleased text by asking an agent for it. That asymmetry exists today,
is documented as intentional, and is not to be "fixed" by pointing either
surface at the other.

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
| user | A role and optional extras per catalog. |

`catalogAdmin` is a wildcard so that new permissions accrue to it automatically
instead of needing to be added to a top role every time.

### Granting rule

Access is granted as roles, not as permissions. Two permissions are
**protected**: `manage_access` and `see_unreleased`.

- A holder of `manage_access` may assign any role that carries neither
  protected permission. Today that is `posluchač`, `čtenář` and `korektor`.
- The same test applies to the role being **replaced**. Changing or revoking the
  access of an account that already holds a protected role is reserved to
  `catalogAdmin`, so a `hostitel` cannot demote a `redaktor` to `posluchač` or
  revoke them outright.
- Nobody changes their own access. A holder of `manage_access` cannot assign
  themselves a role, protected or not; that is a `catalogAdmin` act.
- Only `catalogAdmin` and above may assign a role that carries a protected
  permission (`hostitel`, `redaktor`), and only they may grant extras.

The granter need not hold what the assigned role carries: a `hostitel` can make
someone a `korektor` without being able to correct transcripts. What the rule
prevents is a chain. Protecting `manage_access` generalizes the existing rule
that an OWNER cannot grant OWNER, which exists to stop self-propagating
privilege, and keeps the tier list load-bearing: `catalogAdmin` is the tier that
can mint accounts which grant. Protecting `see_unreleased` keeps unreleased
material an administrative decision: a `redaktor` sees it but cannot pass that
sight on. Because the test is on the permissions a role carries, a role added
later is classified without touching this rule.

Testing the replaced role as well as the assigned one keeps the existing
two-sided check. Today every access mutation asks both
`canGrantCatalogAccessLevel` about the new level and
`canManageExistingCatalogAccessLevel` about the level already held, on update and
on revoke alike. Without the second test the rule would stop privilege from
spreading upward but still let an account strip one above it, which is the same
authority wearing a different hat.

Forbidding self-assignment is mostly new. Under a rule that let a granter pass
on only what it held, assigning to oneself gained nothing and the question never
arose; the two self-checks in the code today are narrow, one stopping an owner
demoting itself out of its own catalog and one stopping any account revoking its
own access. Granting by role removes the natural limit on everything else, so
the general prohibition has to be stated. It also keeps a role conferred rather
than taken, which is what makes the role name worth reading.

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
| `read_transcripts` | Reading a recording's transcript, once it has been released. |
| `see_transcript_variants` | That more than one machine backend exists: the per-recording picker and the multi-backend stream view. Administrative only; every other role reads the default backend. |
| `see_speakers` | The diarization overlay. |

### Correction

| Permission | Covers |
| --- | --- |
| `correct_transcripts` | The correction surface: editing spans, proposing corrections, attesting, and reading the original text within that surface. |
| `publish_transcript` | Releasing a checked transcript for reading, and settling disagreements between correctors along the way. Both are the same person's job: whoever owns a transcript's correction to its end. |

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
| `manage_lookups` | Recorder, location and album rows for this catalog. Assumes [ADR 0007](0007-per-catalog-lookups.md); the rows are global today. |
| `manage_catalog_config` | Catalog paths, sync, default and active flags. `catalogAdmin` only. |

### File delivery — `redaktor` and above, or an individual grant

Held by `redaktor` and `catalogAdmin`. For any role below them these are extras
granted to a named account, and since only `catalogAdmin` grants extras, such a
grant comes from `catalogAdmin`.

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

| Role | Permissions |
| --- | --- |
| posluchač | `stream_audio` |
| čtenář | + `read_transcripts`, `search_transcripts` |
| korektor | čtenář + `correct_transcripts`, `see_speakers` |
| hostitel | čtenář + `manage_access` |
| redaktor | `see_unreleased`, `browse_recordings`, `stream_audio`, `read_transcripts`, `search_transcripts`, `see_speakers`, `correct_transcripts`, `publish_transcript`, `edit_metadata`, `batch_edit_metadata`, `manage_lookups`, `publish_recording`, `manage_events`, `release_events`, `manage_event_posters`, `manage_event_sources`, `use_deep_search`, and the file-delivery permissions |
| catalogAdmin | wildcard, including `see_transcript_variants` and `manage_catalog_config` |

Every role below `redaktor` sees released events and published recordings only,
because none of them holds `see_unreleased`.

Expected occupancy at introduction: one `catalogAdmin`, two `hostitel` (one of
them with `download_transcripts` as an extra), a few `korektor`, and everyone
else `čtenář`. `redaktor` starts empty — its editorial rights currently sit with
the `catalogAdmin`.

## Consequences

- A transcript gains a stored release state alongside `CatalogEntry.isPublished`
  and `CatalogEvent.released`, and the reading surfaces consult it. Every span
  being verified is the workflow invariant that permits setting it; setting it is
  an editorial act, and neither is an authorization decision.
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
  text after the page has switched. The two need different work, because the
  format files have no corrected counterpart until something renders one; see
  [ADR 0006](0006-transcript-correction.md).
- MCP serves the same substituted transcript. The documented decision that a
  listener may read transcripts through MCP stops conflicting with web
  restrictions, because both surfaces now serve one text.
- The catalog settings page is one permission today and mixes access management,
  catalog configuration, event health and bulk transcript export. Splitting the
  roles requires splitting that page into separately gated cards.
- `requiresReadyRecordingScope` and `requiresReleasedEventVisibilityScope` test
  equality against `LISTENER`. They must become `see_unreleased` checks before
  any new role is introduced, or the new role silently gains full visibility.
- The bulk export path and the deep-search worker currently bypass publication
  scoping. Both have to consult `see_unreleased` like every other read.
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
- `manage_lookups` assumes the lookups are per catalog, which they are not today.
  That change carries its own migration, identifier and invariant concerns and is
  a prerequisite for nothing, so it has its own record:
  [ADR 0007](0007-per-catalog-lookups.md). `redaktor` carries the permission from
  the moment that record lands; before then there is no catalog for it to govern.
- Migration is behaviour-preserving: the five existing levels become the first
  rows of the role table, `accessLevelAtLeast` calls become permission checks,
  and only afterwards are `korektor` and `hostitel` added.

## Settled points

- **Unreleased material stops at `redaktor`.** An event cannot be released by
  someone who cannot see it, so `redaktor` holds both `see_unreleased` and
  `release_events`. In practice "unreleased material is for administrators only"
  means `redaktor` and `catalogAdmin`; every role below them loses visibility it
  has today. `see_unreleased` is protected, so only `catalogAdmin` and above can
  assign a role that carries it, and no role can extend it as an extra.
- **`čtenář` and `korektor` stay separate roles.** Folding `correct_transcripts`
  into `čtenář` was considered: the two-attestation rule rather than the
  permission is what protects what readers see, so opening the tool widely is
  safe, and the hours involved argue for the largest possible pool. It was
  rejected because the role is a step rather than a cap — a `hostitel` assigns
  `korektor` with no administrative involvement, so the pool grows without
  merging anything. Keeping them apart also makes being a corrector something a
  person accepts rather than something that arrives with reading, and gives a
  moment at which the editorial convention is handed over. Merging later costs
  one line; unmerging would take something away from people who already had it.
- **A `hostitel` invites anyone below `hostitel`.** Below means a role carrying
  neither protected permission, so a `hostitel` assigns `posluchač`, `čtenář`
  and `korektor` and nothing else — to other people, and to accounts that do not
  already hold a protected role.
- **No transcript is readable at launch, and that is accepted.** Nothing is
  released until a whole transcript has been checked, and a recording runs to
  three hours and several hundred spans, so the first one a reader can open is
  weeks of work by two people away. Nothing is backfilled and no machine
  transcript is grandfathered into the released state.
- **Listeners become readers only once the correction system has been tried and
  trusted** — not once it merely exists, and not once the corpus is corrected.
  Until then the 77 `LISTENER` grants measured in production stay as they are,
  which makes every step of this rework invisible to all but three accounts.
- **Unchecked text is withheld from reading, not from use.** A `čtenář` opening a
  recording whose transcript is not yet released sees how far checking has got,
  not the machine text. The same text still reaches them through search and
  through an agent's answer, where it is a source rather than a document, and
  where the caution the MCP server asks agents to give still applies. Releasing
  is what turns a transcript into something to read.
- **Release is one pattern used three times.** A recording is published, an event
  is released, a transcript is released. Each is a state of the material rather
  than of the actor, each is permitted by a workflow invariant, and each is
  performed deliberately by a person. Keeping the three alike is worth more than
  tailoring any one of them.
- **Backend variants are administrative.** Every role except `catalogAdmin` reads
  one transcript per recording, the configured default from
  `TranscriptBackendPriority`. The picker and the stream view are one permission.
- **Posters and sources stay separate permissions.**
- **Downloaded audio is the playable file.** Original masters are not part of any
  role.
- **File delivery starts at `redaktor`.** No role describing an ordinary
  participant carries a download; below `redaktor` it is granted to a named
  account, because the product is listening and reading inside Besedy.
- **Lookups become per-catalog**, which turns `manage_lookups` into an ordinary
  catalog permission and removes the cross-catalog write path that
  `requireEditorOnAnyCatalog` opens today. Recorded separately in
  [ADR 0007](0007-per-catalog-lookups.md).
