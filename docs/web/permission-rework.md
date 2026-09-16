# Permission Rework Progress

> **Last Updated:** 2026-09-16

**All eleven steps are written and in review.** They are stacked in order, each
on the one before: #109 → #111 → #112 → #113 → #115 → #116 → #117 → #118 →
#119 → #120 → #121 → #122. Two more sit beside them on `main`: this file, and
[#114](https://github.com/lukleh/besedy/pull/114), which fixes the deploy
ordering described below.

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
| 2 | Lookups become per catalog: schema, data, `/api/metadata/*` scoped to the catalog | In review — [#111](https://github.com/lukleh/besedy/pull/111) |
| 3 | Permission checks computed from the level scale inside the policy layer; nothing stored changes | In review — [#112](https://github.com/lukleh/besedy/pull/112) |
| 4 | Roles and extras stored: `CatalogAccess` gains the six role identifiers and an extras list, the roles are defined in code, the five legacy values stay valid | In review — [#113](https://github.com/lukleh/besedy/pull/113) |
| 5 | Catalog settings page split into separately gated cards; the catalog list's publish toggle gated on `publish_recording` instead of `manage_access` | In review — [#115](https://github.com/lukleh/besedy/pull/115) |
| 6 | Granting rule becomes the protected-permission test: what may be assigned, what may be replaced, and no account changing its own access | In review — [#116](https://github.com/lukleh/besedy/pull/116) |
| 7 | Roles assigned: 77 listeners, one reader, two hosts with `download_transcripts` as an extra; legacy values retired | In review — [#117](https://github.com/lukleh/besedy/pull/117) then [#118](https://github.com/lukleh/besedy/pull/118) |
| 8 | Bulk export scoped by the delivery rule; deep-search worker stops passing `accessLevel: null` | In review — [#119](https://github.com/lukleh/besedy/pull/119) |
| 9 | `see_transcript_variants` and `see_speakers` to `catalog_admin`; the stream switch, backend picker and speaker toggle hide on new recording-entry flags, and the stream stops being the default view | In review — [#120](https://github.com/lukleh/besedy/pull/120) |
| 10 | `browse_recordings` becomes a stated choice rather than an accident of the tab switcher | In review — [#121](https://github.com/lukleh/besedy/pull/121) |
| 11 | Original-audio download behind the `catalog_admin` wildcard; transcript download gains its pre-correction variant; the one `canDownload` flag becomes one per download permission | In review — [#122](https://github.com/lukleh/besedy/pull/122) |

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

Steps 5 and 6 come before the roles are assigned because assigning them first
would leave the two hosts holding `manage_access` with nowhere to use it.
Managing access lives on the catalog settings page, and that page is gated by
`canAccessCatalogSettings`, which is owner-or-admin authority rather than a
permission. Until the page is split into separately gated cards, a `host` is
redirected away from the only surface their one job needs. Step 6 is the rule
itself — which roles a holder of `manage_access` may assign, that the same test
applies to the role being replaced, and that nobody changes their own access,
which is new and has no equivalent in today's code.

Step 7 is where behaviour deliberately does change, for three accounts, and it
is the step that needs the `host` role, the extras column and both of the two
steps above to exist. Keeping it separate from steps 3 and 4 is what makes those
two provable.

## What the assignment costs, checked against production

Step 7 was verified against the live grants on 2026-09-16, before any of it was
built. Eighty active grants, none revoked, and the administrator holds no grant
at all.

The 77 listeners are unaffected: `listener` carries what `LISTENER` carried.

The one member is dormant — three logins, three streams, one transcript view,
nothing since 2026-08-30, Labs off — and `reader` keeps the reading and
searching it used.

For the two owners, what they use survives the move to `host`: 1146 audio
streams, 154 transcript views, 27 invitations created, and nine transcript
downloads, the last of which is why the role carries `download_transcripts` as
an extra. What they give up is mostly unused, and measurably so — zero metadata
edits, zero audio downloads, and none of the 198 events, every one of which was
created and last updated by the administrator.

Two of the losses are real and are accepted rather than overlooked. One owner
browses through the recordings list, which their stored tab preference shows,
and `host` has no `browse_recordings`, so the catalog becomes events-only for
them.
The same owner has created three deep-search jobs, and `host` has no
`use_deep_search`. Both were offered to the role and both were declined: the
rights belong to the editorial role, and an owner who wants them can be given
one. The dormant member likewise loses access to a deep-search job shared with
them.

## How this reaches production

The merges are not deployed one at a time; the whole rework goes out in a single
deploy. So the bar a pull request has to clear is that it can be **reviewed and
reverted on its own**, not that it could run in production alone. An
intermediate state the plan passes through — a role that exists before the page
it needs, say — costs review clarity rather than working software.

What has to be checked before that deploy is therefore the whole of it against
the real grants, not each step in turn: what the new model gives every account
compared with what it has today.

One constraint the deploy order used to impose on the steps that carry a
migration, and how it was removed.

`just prod-deploy` started the new container **before** running migrations, so
for a moment the new code served against the old schema — the reverse of the
usual worry. The claim written here first was that step 4 tolerated that,
because nobody holds a role identifier until step 7. **That was wrong**: Prisma
selects every scalar column unless a query names a `select`, and several reads
of `catalog_access` name none, so the new code would have asked for `role` and
`extra_permissions` before the migration created them — every one of those reads
failing until the restart.

[#114](https://github.com/lukleh/besedy/pull/114) moves the migration before the
new container starts, which removes the constraint rather than working around
it. Besedy is not a high-availability deployment, so the short window where the
old container serves against the new schema is acceptable, and a destructive
migration should stop `web` rather than rely on a two-stage deploy.

## The UI follows every split

The web UI never decides a permission itself. It reads booleans from five
payloads, each with a Zod schema on the client, and shows or hides on them:

| Payload | Route | Client schema |
| --- | --- | --- |
| Catalog list | `/api/catalog` | `components/catalog/catalog-list/types.ts` |
| Recording entry | `/api/catalogs/:id/recordings/:hash/entry` | `hooks/use-recording-entry.ts` |
| Catalog features | `/api/catalogs/:id/features` | `lib/features/types.ts` |
| Settings data | settings page loaders | `app/catalog/[catalogId]/settings/*` |
| Admin status | `/api/me/permissions` | `hooks/use-admin-status.ts` |

So a permission that is split or moved on the server is invisible to the user
until the payload carries a boolean for it and an element hides on that boolean.
Where the boolean already exists the step is server-only; where it does not, the
step includes the payload field, the schema, and the element. Checked against
the code on 2026-09-16:

| Element | Was | Now | Step |
| --- | --- | --- | --- |
| Publish toggle in the catalog list | shown on `canManageAccess` | `canPublishRecording` in the list payload | 5 — done |
| Settings page: export card, event health card | shown to anyone who could open the page | one flag per card; the page opens on any card being visible | 5 — done |
| Stream view switch and backend picker | always shown; stream was the default | `canSeeTranscriptVariants` in the recording entry, stored preference ignored when false, reading is the default | 9 — done |
| Speaker overlay toggle | shown whenever diarization exists | `canSeeSpeakers` in the recording entry | 9 — done |
| Audio menu, original-audio item, transcript formats menu | one `canDownload` | one flag per download permission | 11 — done |
| Status column default | keyed on the access level string | `canSeeUnreleased` in the list payload | 7 — done |
| Recordings list and its tab | shown to whoever could edit events | `features.recordings.canBrowse`, and the switcher asks about browsing rather than editing | 10 — done |
| Release event action | same flag as edit event | `canRelease` beside `canEdit` in features | still open, with `release_events` |

A sixth payload joined the five above: `/api/catalogs/:id/features` gained a
`recordings` block in step 10, and its Zod mirror lives in
`hooks/use-catalog-features.ts` rather than in `lib/features/types.ts` — both
have to change together.

Already consumed as server-computed booleans and needing no UI work: event admin
columns, release-state indicators, the deep-search link,
the search box, batch edit, metadata edit, poster and source management, and the
offline cache button, which has no gate and needs none.

## What the writing changed

Four things the plan did not anticipate, recorded because the reasoning matters
more than the order did.

**Step 7 is two pull requests.** Mapping it against the code showed that moving
the resolution onto roles and moving the accounts onto roles are separate
changes with separate risks. [#117](https://github.com/lukleh/besedy/pull/117)
changes where a permission comes from and nothing else, which is what makes it
provable the way steps 3 and 4 were. [#118](https://github.com/lukleh/besedy/pull/118)
carries the migration.

**Assigning roles would have removed the events view from everyone.**
`canBrowseEvents` asked for `browse_recordings`. Under the level scale that was
invisible, because every level carried it; under the roles only the curator
does. So step 7 would have taken the main screen from all 77 listeners and every
reader. Browsing events is not browsing recordings, and the fix belongs to step
10 — it was pulled into #118 because step 7 could not land without it.

**Step 4 also expanded the wrong table.** `PendingCatalogGrant` was left on the
level scale, and the claim path copies a pending grant straight into a real one,
so an invitation accepted after step 7 would have produced a grant with no role
and therefore no permissions. #118 expands it.

**Step 11 has to ship with step 7, not merely after it.** The two hosts carry
`download_transcripts` as an extra, and nothing asked that permission until step
11 — so between the two steps they could not download a transcript at all.
Flagged on #118 and #119 and closed by #122.

## Must not move

**A permission is not done until the UI consumes it.** A step that introduces
or splits a permission ships the payload field, the client schema and the
element together with the policy change, or it has not shipped.

**The release gate does not ship with this rework.** Reading a transcript may
only depend on release once corrections exist, because until then nothing can be
released and `read_transcripts` would resolve to nothing. Measured against
production that would take transcripts from one account today, and from all 77
listeners the moment they are made readers. Until corrections exist,
`read_transcripts` means what it means now: read the transcript. Making the
listeners readers is a separate condition with its own bar — the correction
system tried and trusted — and it constrains the promotion, not the gate.

## Before the deploy

The whole rework goes out at once, so the check is the whole of it against the
real grants rather than each step in turn. What to confirm, in order:

1. **The grant distribution still matches.** The migration's mapping was written
   against 77 `LISTENER`, one `MEMBER`, two `OWNER`, and no `VIEWER` or
   `EDITOR`, read on 2026-09-16. A `VIEWER` or `EDITOR` added since would be
   mapped by the same rule but nobody has decided that it should be. Re-reading
   this was attempted while the steps were being written and production was
   unreachable, so it is worth doing once more rather than assumed.
2. **Run the migration against a copy first.** It was verified against a
   throwaway PostgreSQL 18 with a grant and a pending grant at every level: it
   is idempotent, it leaves a row that already carries a role alone, and it
   leaves no grant without one.
3. **Deploy [#114](https://github.com/lukleh/besedy/pull/114) or merge it
   first.** Two migrations land here, and the old ordering ran them after the
   new container started.
4. **Tell the three accounts whose access changes what changed**, before they
   find out by looking. The one member loses unreleased visibility and
   downloading; the two hosts keep reading, granting access and transcript
   downloads, and lose the editorial rights, the recordings list and deep
   search.

## Waiting on a decision, not on code

None of these blocks any step above.

- The correction data model — spans, attestations and the edit log — is not in
  [ADR 0006](../adr/0006-transcript-correction.md).
- The editorial convention correctors follow. ADR 0006 makes it a prerequisite
  for the correction tool, not for this rework.
- The two questions still open at the end of ADR 0006.

The correction work is no longer waiting on this rework. `correct_transcripts`
and `publish_transcript` exist as permissions, `corrector` exists as a role that
a holder of `manage_access` can hand out, and nothing else in ADR 0006 depends
on a permission that is missing.
