# ADR 0006: Human transcript correction

- **Status:** Proposed
- **Date:** 2026-09-15
- **Revised:** 2026-09-20
- **Canonical references:** [Data model](../data-model.md), [RAG system](../rag-system.md), [ADR 0002](0002-artifact-generations.md), [ADR 0003](0003-web-catalog-projection.md), [ADR 0004](0004-system-boundaries.md), [ADR 0005](0005-catalog-permission-model.md)

## Context

Besedy transcripts are machine output and are not always accurate. The system
currently has no correction surface and no database record of transcript text.
Every transcript route reads immutable-looking pipeline artifacts directly.

The production corpus measured on 2026-09-15 contains one catalog, 253
recordings and 198 primary recordings of events. Those primary recordings total
606.7 hours and average just over three hours. Nine machine transcript variants
exist for each recording, with one configured default. Complete corpus coverage
is therefore not a realistic first goal. The useful unit of commitment is one
recording corrected from beginning to end.

The permission rework has already introduced the vocabulary this feature needs:
`correct_transcripts`, `publish_transcript`, `see_transcript_variants` and
`download_original_transcript`. The `corrector` role carries correction but not
publication. Curators and catalog administrators carry publication. These
permissions currently have no correction feature to govern.

This record assumes the initial group remains small: about eighty users, mostly
people who know one another and can resolve disagreements by talking. The first
version should be simple and durable, not machinery for an anonymous moderation
corps.

## Decision

### The span is the unit of work; the transcript is the unit of publication

Correction works one source segment at a time. Publication always publishes a
complete transcript. Partially corrected text never leaks into a reading,
download, search or MCP response.

A transcript becomes eligible for publication only when every span is done. A
span is done when two distinct people have explicitly approved its current text
revision and no current disapproval applies. Eligibility does not publish
anything automatically: a curator or catalog administrator must deliberately
publish the transcript.

Only primary recordings of events are in scope for the first version. Secondary
recordings have distinct audio hashes and timing and do not inherit corrections
from a primary recording.

### Four consumers deliberately resolve different text

There is no single permissive "best transcript" resolver. Each surface follows
an explicit rule:

| Consumer | Resolution |
| --- | --- |
| Reader and ordinary download | The active reader publication. With no active reader publication, return no transcript text. |
| Search and MCP | The active search publication, otherwise the configured default machine transcript. |
| Correction UI | The live database workspace. |
| Privileged original access | The frozen machine source, or another machine variant where `see_transcript_variants` permits it. |

This separation is a safety property. The machine fallback required by MCP must
never accidentally become a fallback for the normal reading page.

Before a transcript has ever been published, a reader sees correction progress
but not transcript text. Ordinary transcript downloads and bulk export do not
include it. Search and MCP continue to use the machine transcript; users already
understand that an agent uses transcription as a fallible source rather than as
a verbatim document.

Explicit administrative machine-output permissions are exceptions to the
reading gate:

- `see_transcript_variants` allows a catalog administrator to inspect machine
  variants through the backend picker and comparison surface, including before
  publication.
- `download_original_transcript` allows a curator or catalog administrator to
  download the frozen machine source, including before publication.

`see_unreleased` alone does not expose an unpublished transcript through the
ordinary reader. Correctors see the source through the correction UI. Curators
and administrators can also enter that UI because their roles carry
`correct_transcripts`.

After publication, the published corrected transcript is the primary reader
transcript. A catalog administrator may still compare it with machine variants,
and a curator or administrator may download its frozen machine source. A live
post-publication draft remains visible only in the correction UI.

### Search and MCP see a newer version, not a corrected transcript type

A corrected transcript is not another backend and not a parallel search
document. It replaces the machine text under the same logical recording and
backend identity. Search keeps one set of chunks for the audio hash.

The indexing input resolver chooses the active search publication for an audio
hash when one exists and the configured machine transcript otherwise. The
published text changes the existing `transcript_fingerprint`, so the current
incremental sync replaces the chunks for that audio hash in a staged bundle and
atomically switches the bundle pointer. It must not index machine and corrected
chunks side by side.

MCP receives the resolved canonical transcript and treats it like any other
transcript. It has no correction-specific branch, response field or presentation
rule.

### Correction works against one frozen machine source

Any person holding `correct_transcripts` may deliberately start correction for
an eligible primary recording. Merely opening a page creates nothing. The start
action shows which configured default machine transcript will be frozen.

Starting creates one permanent workspace for that recording. A database
constraint prevents concurrent start requests from creating duplicates. The
workspace has no owner or assignment in the first version; the initiator is
recorded only as history.

The start operation succeeds only after both of these exist and agree:

1. An immutable copy of the complete canonical source `transcript.json`, with a
   recorded fingerprint. This preserves metadata, confidence and word timing for
   provenance and exact original downloads.
2. Eager database span rows containing stable span IDs, order, fixed start and
   end times, original text and its hash, and the initial current revision.

Rows are not created lazily. A recording that has not been started costs no span
rows, while a started recording is fully independent of later filesystem state.
Re-transcription, backend-priority changes and source-file replacement cannot
change the workspace.

There is no normal restart or rebase operation. If the wrong source was selected,
an administrator may exceptionally archive the workspace and create a new one;
the abandoned workspace and all of its history remain available for audit. There
is no fuzzy relocation of corrections to new machine segments.

### Current state and immutable history coexist

PostgreSQL is authoritative for work in progress. It keeps efficient current
projections and immutable history rather than reconstructing every page from a
generic event stream.

The logical records are:

- **Workspace:** recording, frozen source identity and fingerprint, current
  pointers and lifecycle.
- **Span:** stable source order and time range, original text, and current text
  revision pointer.
- **Text revision:** immutable normalized text, previous revision, author and
  timestamp.
- **Decision:** immutable approve, disapprove or withdraw action by one person
  against one text revision.
- **Comment:** discussion attached to a span, with the revision visible when it
  was written.
- **Publication:** immutable candidate and result, publisher, status, artifact
  fingerprint and job state.
- **Publication span:** the exact text revision used for every span in a
  publication.
- **Guide revision:** immutable versions of the catalog correction guide.

Current pointers make the page and publication check straightforward. Immutable
records preserve who did what and when. Action timestamps are kept; active
"time spent" is not measured because idle tabs and interruptions make it
misleading.

### Text revisions, not reusable hashes, carry decisions

Approvals and disapprovals reference an immutable revision ID and retain that
revision's text hash as an integrity check. Binding only to a hash would allow an
old approval to become valid again after text changed from A to B and later back
to A. That is not allowed: every edit invalidates prior decisions, including a
later return to identical wording.

The server normalizes text before deciding whether it changed: Unicode form,
line endings, leading and trailing whitespace, and repeated whitespace are
canonicalized. Capitalization, punctuation and words remain meaningful. Saving
text that normalizes to the current value is a no-op and creates no revision.

The first version has no special unintelligible state and no marker such as
`[unintelligible]`. A publishable text revision is non-empty. If a corrector
cannot determine the words, they disapprove and may comment rather than guess.
This can be revisited if real recordings demonstrate a need for an explicit
empty-text outcome.

### Approval is explicit and fixed at two people

The first version always requires approvals from two distinct accounts. The
threshold is not configurable and has no administrative UI. Each publication
still records `required_approvals: 2` so the historical policy is explicit and a
future versioned policy can be introduced without ambiguity.

Playback never creates an approval. The system does not attempt to prove that a
person played a segment, watched a timer or kept the tab focused. This group can
be trusted to use the tool honestly, and such telemetry would complicate the
first version without making the statement materially stronger.

An unchanged span has an explicit **Approve and continue** action. An edited
span has **Save, approve and continue**. The latter creates the revision and the
editor's approval in one transaction. There is no persistent save-without-
decision action: an unfinished edit remains a local draft. An uncertain person
leaves the current text intact, disapproves it and may add a comment.

Every reviewer uses this same workflow. There is no first-pass and second-pass
mode and no continuous-playback shortcut that approves spans merely because the
playhead passed them. Later reviews are faster because correct text requires
only one deliberate action.

The primary keyboard action is `Ctrl+Enter` or `Cmd+Enter`, which performs the
same approve or edit-and-approve command as the visible button. Approval is not
a casual single-key action. Disapprove and withdraw remain explicit buttons.
After a successful approval the surface advances to and plays the next span.

### Decisions are visible, reversible by their author and never outvoted

For each person, their latest decision on the current revision counts. Approving
after disapproving replaces that person's effective disapproval; withdrawing
leaves them with no effective decision. Withdrawal appends history and never
deletes the earlier action. Nobody, including an administrator, can withdraw or
erase another person's decision.

A current disapproval blocks the span regardless of how many approvals it also
has. Extra approvals do not outvote an objection. Text must change, or the
objector must approve or withdraw. There is no adjudication or publisher
override in the first version.

Comments are optional and never block publication. They belong primarily to the
span, record which revision the author saw, and remain visible after later
edits. Their exact thread, resolution and overview experience is left to the UI
design; their persistence and non-blocking semantics are not.

Correctors are not anonymous to one another. The span history makes clear who
created each revision, approved, disapproved, withdrew or commented and when.
The main flow may show a quiet "one approval" label, but identities remain
available before another person acts. Transparency and direct communication are
more useful here than blind review.

### Span state is derived

No mutable workflow status duplicates the decisions. The UI derives four
states for the current revision:

| State | Meaning |
| --- | --- |
| Not reviewed | No current approval. |
| Needs second approval | One distinct person has approved. |
| Done | Two distinct people have approved and nobody currently disapproves. |
| Needs attention | At least one current disapproval; publication is blocked. |

Whether text is unchanged machine text or human-edited is separate information,
not a workflow state. "Done" appears only after the second approval. Editing
creates a new revision with the editor's explicit approval, so the new revision
normally starts at "Needs second approval."

### Concurrent work uses revision checks, not leases

Every decision or edit command carries the revision ID the user saw. The server
locks the span for the short transaction and rejects the command if the current
revision differs. It preserves no last-write-wins path and does not auto-merge
short transcript text.

On conflict, the UI retains the local draft and shows the newer text so the
author can decide whether to reapply the change. Commands also carry an
idempotency key, so double-clicks and network retries cannot create duplicate
decisions.

There are no queue leases in the first version. Optimistic revision checking is
the correctness guarantee; leases would add expiry and recovery state only to
reduce a rare ergonomic collision.

Comments do not fail merely because the text changed while they were written.
They attach to the span and record the revision the author had seen.

### Correction changes text, not timing

Source segment boundaries remain fixed. The first version has no split, merge,
boundary dragging or word-timing reconciliation. Correction identity is the
stable database span; citations and playback continue to use the source start
and end times.

Published corrected segments contain:

- the fixed source `start` and `end`;
- the approved current `text`;
- `confidence: null`;
- `words: []`.

The reader already falls back to whole-segment highlighting when word arrays are
empty. Its diarization overlay resolves the speaker at the segment start, so
text-only publication does not require reconstructed word timing or speaker
changes. Speaker attribution itself remains out of scope.

### Correction has its own large-screen surface

Correction lives on a dedicated page rather than as controls added to the
reader. The page owns segment playback, keyboard handling, text editing and
history.

Correction is supported only on desktop and on a tablet in landscape
orientation. A phone or portrait tablet shows an explanation to use a larger
landscape screen; it does not load the working transcript or render correction
controls. This is a product-support constraint, not an authorization boundary:
all write commands still enforce permission, revision and workflow invariants
on the server.

The larger corrector dashboard—how people see all of their work, what remains,
other people's decisions and discussion across recordings—is intentionally not
settled here. The pilot should determine what overview is actually useful. A
recording-level surface must at least support stopping and resuming within a
multi-hour recording.

### Readers see two progress measures before first publication

With no reader publication, the reader page shows no transcript text and no
corrector identities or disputed-span detail. It shows:

- **Reviewed once:** duration covered by spans that have at least one current
  approval or disapproval.
- **Fully approved:** duration covered by done spans.

Both are divided by the total duration covered by source spans. Duration is more
representative than span count because machine segments vary greatly in length.
If no workspace exists, the page says correction has not started.

Once a reader publication exists, readers keep seeing that immutable snapshot
while later work proceeds. Draft progress is no longer shown on the reader page.

### Publication authority remains separate from correction

The `corrector` role does not carry `publish_transcript`. Curators and catalog
administrators may publish, republish and unpublish. Completing the second
approval only makes a transcript eligible; it never promotes the corrector or
publishes automatically.

A publisher may also happen to be one of the two approvers because their curator
or administrator role includes correction, but publication is not a third
review. The server rechecks every current revision, two distinct approvals and
the absence of disapproval when publication starts. Publication cannot override
an incomplete or disputed span.

### Publications are immutable snapshots over a live workspace

The correction workspace remains editable after publication. A publication is
an immutable manifest of one exact revision for every span. Editing one span
after publication invalidates decisions only for the new revision of that span;
unchanged spans retain their decisions. Readers, search and MCP keep the prior
snapshot until the changed transcript is eligible and deliberately republished.

Published artifacts are versioned by publication and never overwritten:

```text
corrections/
  <workspace-id>/
    source/
      transcript.json
    publications/
      <publication-id>/
        transcript.json
        transcript.txt
        transcript.srt
        transcript.vtt
```

The exact storage root follows the existing writable-artifact conventions. The
important invariant is the workspace/publication identity, not these literal
directory names. Database pointers choose active artifacts; file existence alone
never means a transcript is published.

### Reader and search publication pointers are separate

One `published` boolean cannot represent the chosen unpublish behavior. A
workspace therefore has two nullable active pointers:

- **Reader publication:** used by the reader, ordinary download and bulk export.
- **Search publication:** used to resolve text for search indexing and MCP.

The first successful publication sets both to the new snapshot. A normal
unpublish clears only the reader pointer. Search and MCP keep the last corrected
snapshot, and the immutable artifacts remain. Republishing an unchanged snapshot
restores the reader pointer without rendering or indexing again.

If text changed, republishing creates a new publication and moves both pointers
only after the job succeeds. Exceptional removal of corrected text from search
or MCP is a separate administrator operation that clears or replaces the search
pointer and refreshes the index. It is intentionally not part of ordinary
unpublish and need not have a first-version UI.

### Publication is one durable, retryable job

Starting publication creates a `pending` publication with the exact span-
revision manifest and briefly locks workspace writes. One job then:

1. Materializes and validates the canonical corrected JSON in the publication's
   staging directory.
2. Renders `txt`, `srt` and `vtt` from that JSON.
3. Builds and validates an incremental search update that replaces the same
   audio hash in the same logical backend scope.
4. Switches the staged index bundle.
5. Marks the publication successful, moves the database pointers and unlocks
   the workspace.

The reader pointer is never moved before artifacts and indexing are ready. The
filesystem/index switch and PostgreSQL cannot form one transaction, so the job
is idempotent and reconciles the only possible crash window: search may briefly
contain the verified new snapshot while database consumers still point to the
old one. That is the safe direction under the access policy. A retry recognizes
the indexed fingerprint and completes pointer activation.

Failure records the error, leaves active database pointers unchanged and
unlocks the workspace. Failed artifacts are never resolved by a consumer. Job
attempts are recorded separately from the logical publication. If the workspace
is unchanged, an administrator may retry the same publication; after another
edit, a new publication candidate is required.

Unpublishing starts no job. It clears the reader pointer immediately.

### The canonical JSON carries minimal provenance

The resolved transcript remains valid under the canonical transcript schema.
It keeps the source transcript's honest `meta.backend`, `meta.model` and
`meta.generation_params`, rebuilds derived transcript text from the published
segments, and adds a small provenance block:

```json
{
  "meta": {
    "correction": {
      "schema_version": 1,
      "workspace_id": "...",
      "publication_id": "...",
      "source_fingerprint": "...",
      "published_at": "...",
      "required_approvals": 2
    }
  }
}
```

The JSON does not carry corrector names, comments, decision history or redundant
per-segment approval counts. PostgreSQL owns that audit history. Search and MCP
ignore `meta.correction`; for them this is simply the newer version of the same
transcript.

### The correction guide is catalog data

Correctors need a short shared convention before the pilot. The active guide is
stored as Markdown in PostgreSQL with immutable revisions. Every corrector may
read it; only a catalog administrator may edit it, using the existing
`manage_catalog_config` authority. A guide edit becomes active immediately and
does not invalidate decisions. Each publication records the active guide
revision for audit.

The initial convention is a faithful, readable transcript:

- correct misheard words, names, numbers, capitalization and punctuation;
- preserve meaning, wording, uncertainty and meaningful repetition;
- do not improve style or correct factual and grammatical mistakes the speaker
  actually made;
- use ordinary orthography without erasing meaningful dialect or unusual word
  choice;
- omit incidental fillers or false starts only when meaning, emphasis and
  character are unchanged;
- do not guess when audio is unclear—disapprove and optionally comment;
- do not introduce ad-hoc markers such as `[unintelligible]`.

The UI copy may refine examples during the pilot without changing these
principles.

### The first release is a narrow pilot

The complete correction and publication path ships before the role is assigned
widely. Two trusted people correct two or three representative primary
recordings: an easy one, a difficult one, and preferably one with names,
specialized language or poor audio. A curator or administrator publishes them
and verifies the reader, formats, search, MCP, original access, republishing and
unpublishing.

The pilot asks whether explicit span approval is comfortable, where people
disagree despite the guide, whether comments suffice, what navigation is
actually missing, and whether indexing replaces rather than duplicates the
recording. Stored action counts and timestamps support that review; direct
conversation supplies the interpretation.

No existing machine transcript is grandfathered into reader publication.

## Consequences

- The database is authoritative for correction work and audit history. Generated
  JSON and format files are immutable publication artifacts.
- A stable source copy and eager span import make the workspace independent of
  retranscription and backend priority changes.
- Publication eligibility is derived from revision-bound decisions. There is no
  mutable span status that can drift from its approvals and disapprovals.
- The two-person rule is explicit and fixed. Editing and approving are atomic,
  playback is not evidence, and users may withdraw only their own decisions.
- Correctors see one another's identities and activity. The design relies on a
  small group being able to communicate rather than on anonymity, voting or
  adjudication.
- The first version corrects text only. Segment timing remains useful for audio
  following, citations and subtitle cues; word timing and segmentation quality
  remain machine output limitations.
- Reader access and search/MCP resolution intentionally diverge before first
  publication and after unpublish. That is the product decision, not propagation
  lag.
- Explicit original/variant permissions remain useful before publication and do
  not turn machine text into the ordinary reader transcript.
- Search sees one logical transcript per recording. A publication changes its
  fingerprint and replaces its chunks; it never creates a corrected backend.
- Publication requires a new durable job that materializes, renders, indexes and
  activates one immutable snapshot. Until that job exists, nothing can be
  published.
- The correction page is unavailable on phones and portrait tablets. The normal
  reader and MCP behavior remain responsive as they are today.
- ADR 0005 consequently uses **publish** for transcripts, grants publishers no
  adjudication, and describes explicit privileged-original access rather than
  treating `see_unreleased` as a general transcript bypass.

## Settled points

- Corrections are current database projections plus immutable history.
- A workspace eagerly imports and freezes one configured default source.
- Every persisted text edit is paired atomically with the editor's approval.
- Two distinct explicit approvals and no current disapproval make a span done.
- Decisions bind to a revision ID and hash; old decisions never revive.
- Comments are optional, survive edits and never block publication.
- Correctors see who edited, approved, disapproved, withdrew and commented.
- Optimistic revision checks prevent lost updates; v1 has no leases.
- There is no unintelligible marker or empty-text outcome in v1.
- Span boundaries stay fixed; v1 has no split, merge or word-timing repair.
- Correctors cannot publish. Curators and catalog administrators can.
- A publication is an immutable snapshot while the workspace stays live.
- Reader and search publication pointers are separate; ordinary unpublish clears
  only the reader pointer.
- Search and MCP treat corrected text as a newer version of the same transcript.
- The JSON carries minimal `meta.correction` provenance; detailed audit remains
  in PostgreSQL.
- Correction guide revisions live in PostgreSQL and only catalog administrators
  edit them.
- Correction is available only on desktop and landscape tablet layouts.
- The system is piloted with two correctors on two or three primary recordings
  before correction access is widened.

## Deferred questions

- The cross-recording corrector overview: personal work, remaining work,
  disagreements and discussion.
- The detailed recording navigation and comment-thread presentation beyond the
  persistence and workflow rules fixed here.
- Whether real use requires an explicit unintelligible/intentional-empty outcome.
- Whether a larger, less personal correction corps eventually needs assignments,
  leases, blind review, notifications, configurable thresholds or adjudication.
