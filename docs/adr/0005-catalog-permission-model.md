# ADR 0005: Catalog permission model

- **Status:** Proposed
- **Date:** 2026-09-15
- **Canonical references:** [Web security](../web/security.md#access-control), [MCP server](../web/mcp-server.md#access-matrix)

## Context

Catalog authorization is a single ordered scale, `LISTENER < VIEWER < MEMBER <
EDITOR < OWNER`. Gaining a capability requires moving up the scale, which also
widens visibility, because the scale carries two unrelated concerns at once:
*which material exists for an actor* and *what the actor may do with it*.

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

Visibility here means precisely one thing: **the release state of the
material**. On that axis `see_unreleased` is the only key, and nothing else
opens it. Other permissions do widen what an actor can see along other axes —
`correct_transcripts` shows unchecked text inside the correction surface,
because one cannot correct what one cannot see, and `see_transcript_variants`
shows the machine transcripts other than the default. Neither reaches unreleased
material, which is what the orthogonality above is about.

Permissions are the semantics: every gate asks whether a permission is present,
never whether a level is high enough.

The typed capability layer stays, and permissions become what it is computed
from. `security.md` already requires route and page code to depend on that layer
rather than on ad hoc policy logic, it is consumed by pages, API routes, MCP and
the browser, and a bare permission set at the call site invites exactly the ad
hoc checks the layer exists to prevent. So `canViewCatalogTranscripts` and its
siblings survive as thin wrappers over `has(actor, 'read_transcripts')`, which
also keeps the mechanical step of the rework inside the policy layer instead of
spreading it across every caller.

### Roles are named permission sets

Roles are defined in code, the way feature rollouts already are. An account
stores a role name per catalog, not an expanded set. Adding a role is a commit,
not a migration and not a runtime editor.

`CatalogAccess.accessLevel` becomes the stored role and its extras sit beside it
as a list on the same row, so an account's effective set is readable without a
join. Identifiers are English and lower case; the Czech names in this record are
what the interface and this conversation use.

| Identifier | Name here |
| --- | --- |
| `listener` | posluchač |
| `reader` | čtenář |
| `corrector` | korektor |
| `host` | hostitel |
| `curator` | redaktor |
| `catalog_admin` | catalogAdmin |

`curator` rather than `editor` deliberately. The retired `EDITOR` level meant
metadata editing alone, while this role runs the archive's editorial work;
reusing the word for a wider meaning is the kind of collision that misleads a
reader a year from now.

`catalog_admin` is a stored role like any other, so a person can hold it for one
catalog without being a system administrator. `isCatalogAdmin` is then true for
a system administrator **or** a holder of that role. Nobody holds it at
introduction.

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
occasional purposes. Those permissions belong to the roles that run the archive
— `redaktor` and `catalogAdmin` — and to **individually named accounts** below
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
member did. Audio downloads disappear for all three of them. Transcript
downloads disappear for one, because the two owners become hosts carrying
`download_transcripts` as an extra — the mechanism working as intended: the role
describes the ordinary case and the exception is named.

Offline caching therefore needs no permission of its own. It delivers bytes, but
it delivers the same listening `stream_audio` already describes.

### The span is the unit of work; the transcript is the unit of release

Correction proceeds span by span and improves the corpus continuously. Reading a
transcript from end to end is a different act, and it opens only when the whole
transcript has been checked and **released**.

Those two facts are not in tension; they answer different questions. Correction
in progress is kept apart: nothing a corrector writes leaves the correction
surface until the transcript is released. Release is then the one moment at
which the recording's transcript changes, and it changes for everyone at once —
readers, search and agents alike. It is also an editorial statement about the
whole of the transcript, which cannot be made span by span.

So a transcript carries a release state, the third instance of a pattern this
system already uses twice: a recording is published, an event is released, and
now a transcript is released. In each case the state belongs to the material,
not to the actor, and in each case a workflow invariant permits it — an event
needs exactly one primary recording, and a transcript needs every span verified.
Releasing is then a deliberate act by a person, not an automatic consequence of
the last attestation landing.

**Like the stance on file delivery, this gate decides how the text is offered,
not whether it can be obtained.** Search returns passages from unreleased
transcripts, and an agent asked through MCP will hand over the whole of one.
What release withholds is the transcript *as a document to sit and read*. It is
a statement about when a text is fit to be presented that way, not a boundary
around the words.

There is therefore still no permission for "corrected transcripts" as distinct
from "all transcripts". A `čtenář` holds `read_transcripts` and reads released
transcripts, exactly as they browse released events. Unchecked text stays
reachable in the places where working on it is the point:

- inside the correction surface, which `correct_transcripts` grants;
- to `redaktor` and `catalogAdmin` through `see_unreleased`;
- through search and agents, which are not reading surfaces — see below.

### Search is scoped by the event, never by the transcript

On the axis that decides what material exists for an actor, search behaves like
every other read: it returns material from released events, and an actor holding
`see_unreleased` searches the transcripts of unreleased ones too, in the web
application and through MCP alike. There is no special rule.

What does not enter into it is the transcript's own release state. Search works
over the machine transcript until the transcript is released, and over the
released transcript afterwards; corrections in progress reach it no more than
they reach anyone else. Release gates *reading* — the transcript view, its
download, the bulk export — and nothing else: an unreleased transcript's machine
text stays searchable, exactly as it is today.

The invariant the code holds, that search must never be broader than transcript
access, therefore has to be read at the level of the **catalog**: an actor may
not search a catalog whose transcripts it may not read. It does not mean an
actor may not search a transcript it cannot open, which under release gating is
the normal case. The comment predates release being a state of the material
rather than a property of the role, and rereading it the old way would gate
search and undo this decision.

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

- A holder of `manage_access` may assign any role that carries neither protected
  permission. Today that is `posluchač`, `čtenář` and `korektor`.
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
`canManageExistingCatalogAccessLevel` about the level already held, on update
and on revoke alike. Without the second test the rule would stop privilege from
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
| `see_unreleased` | Unreleased events, unpublished and non-actionable recordings, unreleased transcripts, and the release-state indicators that only make sense alongside them. |

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
| `see_speakers` | The diarization overlay. Administrative for the same reason as the line above: it is unevaluated machine output, it names nobody, and it currently tells an ordinary reader nothing useful. |

### Correction

| Permission | Covers |
| --- | --- |
| `correct_transcripts` | The correction surface: editing spans, proposing corrections, attesting, and reading the original text within that surface. |
| `publish_transcript` | Releasing a checked transcript for reading, and settling disagreements between correctors along the way. Both are the same person's job: whoever owns a transcript's correction to its end. |

### Search

| Permission | Covers |
| --- | --- |
| `search_transcripts` | Semantic and lexical search over every transcript in the catalog, released or not. Unlike `read_transcripts` it is not gated on release. |
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

**Delivery is never broader than reading.** These permissions decide whether an
account may take files out, not which material it may take: the scope is always
whatever that account can read. A `redaktor` holds `see_unreleased` and so
downloads unreleased transcripts too; a `čtenář` granted a download takes
released ones only. Audio follows the same rule against what the account may
stream, and so does the bulk export, so no download carries a release test of
its own.

A `korektor` is not an exception to this. Their access to unchecked text is
access to a working surface, not a right to read it, so a `korektor` granted a
download still takes released transcripts only.

| Permission | Covers |
| --- | --- |
| `download_audio` | The playable audio file. Original masters stay inside the `catalogAdmin` wildcard. |
| `download_transcripts` | File delivery of a transcript the account can already read. |
| `download_original_transcript` | The machine text underneath, as a variant of that same download — for a released transcript, what the corrections replaced. |
| `bulk_export_transcripts` | Catalog-wide export. The highest-impact permission in the catalogue: one request yields the whole corpus as data. |

### Outside the catalog scope

The admin panel, user management, audit log, MCP usage, transcript backend order
and catalog sync remain system-level rights of `admin` and `superadmin`. No
catalog permission reaches them.

## Roles

| Role | Name here | Permissions |
| --- | --- | --- |
| `listener` | posluchač | `stream_audio` |
| `reader` | čtenář | + `read_transcripts`, `search_transcripts` |
| `corrector` | korektor | `reader` + `correct_transcripts` |
| `host` | hostitel | `reader` + `manage_access` |
| `curator` | redaktor | `see_unreleased`, `browse_recordings`, `stream_audio`, `read_transcripts`, `search_transcripts`, `correct_transcripts`, `publish_transcript`, `edit_metadata`, `batch_edit_metadata`, `manage_lookups`, `publish_recording`, `manage_events`, `release_events`, `manage_event_posters`, `manage_event_sources`, `use_deep_search`, and the file-delivery permissions |
| `catalog_admin` | catalogAdmin | wildcard, including `see_transcript_variants`, `see_speakers` and `manage_catalog_config` |

Every role below `curator` sees released events and published recordings only,
because none of them holds `see_unreleased`.

Occupancy at introduction, from the production figures: 77 `listener`, two
`host` carrying `download_transcripts` as an extra, one `reader`, and the
administrator reaching every catalog through `isCatalogAdmin` without holding a
grant. `corrector` fills as people are asked; `curator` and `catalog_admin`
start empty.

## Consequences

- A transcript gains a stored release state alongside `CatalogEntry.isPublished`
  and `CatalogEvent.released`, and the reading surfaces consult it. Every span
  being verified is the workflow invariant that permits setting it; setting it
  is an editorial act, and neither is an authorization decision.
- Because correction substitutes rather than gates, search needs no notion of
  correction state for authorization. It needs the index to be refreshed when a
  transcript changes, which the incremental per-`audio_hash` sync keyed on
  `transcript_fingerprint` already does. This is existing machinery, not new
  index work.
- Keeping corrections apart until release removes work rather than adding it.
  Before release every surface — the transcript view, its download, the bulk
  export, search and MCP — serves the machine transcript; after release all of
  them serve the released one, which has been fully verified, materialized and
  rendered. No reader anywhere merges partially corrected text, and the only
  resolution rule is "the released transcript if there is one, otherwise the
  default backend". See [ADR 0006](0006-transcript-correction.md).
- The catalog settings page is one permission today and mixes access management,
  catalog configuration, event health and bulk transcript export. Splitting the
  roles requires splitting that page into separately gated cards.
- `requiresReadyRecordingScope` and `requiresReleasedEventVisibilityScope` test
  equality against `LISTENER`. They must become `see_unreleased` checks before
  any new role is introduced, or the new role silently gains full visibility.
- The bulk export path and the deep-search worker currently bypass publication
  scoping. The export is covered by the delivery rule above, which scopes it to
  what the account can read; the worker has to consult `see_unreleased` like
  every other read.
- The recording page's "download original audio" item moves behind the
  `catalogAdmin` wildcard, and the transcript download route gains a variant
  parameter for the pre-correction text.
- Download controls disappear for almost every account. Today `MEMBER` and above
  see them; afterwards only accounts holding an explicit extra do. This is a
  visible product change, not only a policy one.
- A download permission bounds **file delivery, not text extraction.** A reader
  can copy a whole transcript from the page, and an agent asked for the full
  text through MCP can hand it over. If the goal is to control who holds the
  corpus as data rather than who gets a convenient button, download permissions
  alone do not achieve it.
- `manage_lookups` assumes the lookups are per catalog, which they are not
  today. That change carries its own migration, identifier and invariant
  concerns and is a prerequisite for nothing, so it has its own record: [ADR
  0007](0007-per-catalog-lookups.md). `redaktor` carries the permission from the
  moment that record lands; before then there is no catalog for it to govern.
- The mechanical part of the rework preserves behaviour — `accessLevelAtLeast`
  calls become permission checks inside the policy layer, and the capability
  objects above it keep their shape. **Assigning the roles does not**, and that
  is intended rather than incidental. Measured in production the whole of it is
  three accounts:

  | Today | Count | Becomes | Effect |
  | --- | --- | --- | --- |
  | `LISTENER` | 77 | `listener` | unchanged |
  | `MEMBER` | 1 | `reader` | loses downloads, sight of unreleased material, and the diarization overlay |
  | `OWNER` | 2 | `host` | loses the editorial rights below |
  | `VIEWER` | 0 | `reader` | nobody holds it |
  | `EDITOR` | 0 | `reader` + `edit_metadata` | nobody holds it |

- Neither owner is the administrator, who holds no catalog grant at all and
  reaches the catalog through `isCatalogAdmin`. As `host` the two of them keep
  listening, reading, searching and managing access, and give up unreleased
  visibility, event management and release, recording publication, metadata
  editing, posters, sources, deep search, the diarization overlay, audio
  downloads and the settings page. That is acceptable because it is not what
  they do: in practice they add users and occasionally download a transcript,
  and the transcript download they keep, as an extra. The role finally describes
  the work rather than the history.
- `curator` starts empty, so the editorial rights it names sit with the
  `catalog_admin` until somebody is given them.
- **The release gate must not ship with the permission rework.** It can only
  arrive together with the correction system, because until then nothing is
  released and nothing can release anything. Switching it on earlier would take
  transcripts away from every account that reads them today without
  `see_unreleased` — measured in production that is one, and it would be all 77
  listeners the moment they were made readers. Until corrections exist,
  `read_transcripts` means what it means today: read the transcript. This is a
  condition on the order of work, not an implicit consequence of it.

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
- **Listeners are made readers; they do not become them.** Nothing promotes
  anyone automatically. Someone changes each account, and the change waits until
  the correction system has been tried and trusted — not until it merely exists,
  and not until the corpus is corrected. Until then the 77 `LISTENER` grants
  measured in production stay as they are, which makes every step of this rework
  invisible to all but three accounts.
- **What a new reader gets first is search, not reading.** `search_transcripts`
  works from the first day over every transcript; `read_transcripts` returns
  nothing until a transcript is released, and at twenty to thirty-five
  person-hours per recording across 198 recordings, most never will be. That is
  a coherent product — searching works, reading arrives one transcript at a time
  — but it should not be promised as anything else.
- **Unchecked text is withheld from reading, not from use.** A `čtenář` opening
  a recording whose transcript is not yet released sees how far checking has
  got, not the machine text. The same machine text still reaches them through
  search and through an agent's answer, where it is a source rather than a
  document, and where the caution the MCP server asks agents to give still
  applies. Releasing is what turns a transcript into something to read.
- **Corrections in progress reach nobody outside the correction surface.** Not
  the reading surfaces, not search, not agents. Release is the single moment the
  transcript changes, and it changes everywhere at once.
- **Release is one pattern used three times.** A recording is published, an
  event is released, a transcript is released. Each is a state of the material
  rather than of the actor, each is permitted by a workflow invariant, and each
  is performed deliberately by a person. Keeping the three alike is worth more
  than tailoring any one of them.
- **Machine-output views are administrative.** Two permissions sit with
  `catalogAdmin` alone for the same reason: they expose raw model output that
  has not been evaluated and that tells an ordinary user nothing useful yet.
  `see_transcript_variants` covers the backend picker and the stream view, so
  every other role reads the one default from `TranscriptBackendPriority`.
  `see_speakers` covers the diarization overlay, which distinguishes turns
  without naming anyone. Both are candidates to open later — diarization once
  speaker attribution becomes a phase of correction — but neither earns a place
  in a role today.
- **A released transcript therefore carries no speaker information for its
  audience**, in material that is by its nature discussion. This is accepted for
  now rather than overlooked: the overlay identifies nobody, and attributing
  speech is a later phase built on the same span mechanism.
- **Posters and sources stay separate permissions.**
- **Downloaded audio is the playable file.** Original masters are not part of
  any role.
- **File delivery starts at `redaktor`.** No role describing an ordinary
  participant carries a download; below `redaktor` it is granted to a named
  account, because the product is listening and reading inside Besedy.
- **Lookups become per-catalog**, which turns `manage_lookups` into an ordinary
  catalog permission and removes the cross-catalog write path that
  `requireEditorOnAnyCatalog` opens today. Recorded separately in [ADR
  0007](0007-per-catalog-lookups.md).
