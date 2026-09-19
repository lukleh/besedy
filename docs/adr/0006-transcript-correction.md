# ADR 0006: Human transcript correction

- **Status:** Proposed
- **Date:** 2026-09-15
- **Revised:** 2026-09-19
- **Canonical references:** [Data model](../data-model.md), [RAG system](../rag-system.md), [ADR 0002](0002-artifact-generations.md), [ADR 0003](0003-web-catalog-projection.md), [ADR 0005](0005-catalog-permission-model.md)

## Context

Besedy transcripts are machine output and are not always accurate. Nothing in
the system lets a person fix them: every transcript route is read-only and no
table holds transcript text.

What the material looks like, measured in production on 2026-09-15: one catalog,
253 recordings, 198 of them primary recordings of events, 606.7 hours in those
198 — an average of just over three hours each. Nine transcript variants exist
per recording, of which one is the configured default.

What the existing system offers:

- Segment and word level `confidence` in every transcript.
- No segment identifiers. A segment is addressable only by its time range, its
  text, and its position in an array.
- Transcript artifacts are immutable within a generation, and re-running
  transcription with `--overwrite` replaces them in place.
- Transcript reads go through two functions in `lib/transcript`:
  `loadTranscript()` for the recording page, the backend comparison view and
  MCP, and `readTranscriptFile()` for the transcript download route and the bulk
  export.
- Diarization is already merged into the reading view as an overlay resolved at
  render time, from a separate artifact.
- Agent-facing guidance already tells an agent to qualify a quotation when a
  passage looks badly transcribed, which is a workaround for the absence of any
  way to fix it.
- The permission rework has shipped the scaffolding this system needs:
  `correct_transcripts`, `publish_transcript` and `download_original_transcript`
  exist in `web/src/lib/policy/catalog-permissions.ts`, and `corrector` is a
  role a holder of `manage_access` can hand out. All of them gate nothing yet.
  Nothing here waits on that rework any longer.

## Decision

### Corrections are database records; artifacts stay immutable

Corrections are authoritative PostgreSQL rows. Transcript JSON on disk is never
rewritten, which keeps [ADR 0002](0002-artifact-generations.md) intact and
follows [ADR 0003](0003-web-catalog-projection.md), where user-authored state is
authoritative in PostgreSQL rather than reconstructed from pipeline output.

### The span is the unit of work; the transcript is the unit of publication

Per [ADR 0005](0005-catalog-permission-model.md), correction substitutes at the
level of the **span**. A recording has one transcript in which each span is
either machine output or verified text, and a partly corrected recording is the
normal state for years rather than a transitional one.

That improving text stays inside the correction surface. Nothing a corrector
writes reaches a reader, search or an agent until every span has been verified
and a person **publishes** the transcript; publication is the one moment the
recording's transcript changes, and it changes for every surface at once.
Reading end to end is an editorial statement about the whole document and cannot
be made span by span.

So the work is granular and the publication is not, and the record has to keep
both. A coverage figure derived from the spans — duration checked against total
duration — is what stands for a transcript until it is published.

**On the verb.** The existing system already splits two verbs by entity:
recordings are published (`CatalogEntry.isPublished`, gated by
`publish_recording`) and events are released (`CatalogEvent.released`, gated by
`release_events`). A transcript hangs off a recording, and the permission that
has already shipped is `publish_transcript`. This record therefore says
**publish**, not release, everywhere it speaks about transcripts.

### The unit is a segment of the default backend, anchored by time

Correction happens on one backend — the configured default — because correcting
nine variants of the same speech is not work anyone will do. The verified layer
that results is keyed by **time**, not by backend: it records what was said
between two moments, and the machine transcripts become proposals underneath it.

A published transcript therefore ranks **above** `TranscriptBackendPriority`
rather than inside it. Resolution is: the published corrected transcript if
there is one, otherwise the highest-priority backend. Reordering that table
changes which machine transcript stands in for the recordings nobody has
finished, and cannot disturb one that has been published — which follows from
the verified layer belonging to the recording rather than to the backend it
started from.

Because segments carry no identifiers, a span is anchored by its **time range
plus a hash of its source text**. The segment index is stored as a hint, never
as the identity. Rows are created lazily on the first human touch; an untouched
span has no row.

### Correction works against a frozen source

When a recording is taken on for correction, the machine transcript it is being
corrected against is **snapshotted**, and that snapshot is what every span is
anchored to for the life of the work. Re-transcription can happen whenever it
likes and cannot touch it.

This is fundamental rather than convenient. A published transcript means *a
human verified this text*, and that statement is only meaningful against a fixed
thing. Transcript artifacts look immutable but are not reliably so — re-running
transcription with `--overwrite` replaces them in place — so without a snapshot
the baseline a person checked could be swapped out from under the record of
their having checked it.

Two consequences follow, and both remove machinery rather than adding it:

- **Corrections can never be disturbed by re-transcription**, so nothing has to
  relocate spans by time overlap and text similarity, and no span is ever marked
  stale for a person to resolve. That whole class of problem is designed out.
- **A published transcript stays published**, whatever is re-transcribed
  afterwards. It outranks every backend already, and a newer machine transcript
  is simply a better proposal underneath something a person has verified.

Adopting a new transcription for a recording already under correction is
therefore a deliberate act of **starting again** — abandoning the work against
the old snapshot and taking a new one — and never something that happens to a
corrector while they are working.

The design now holds two immutable snapshots per corrected recording, at the two
ends of the work: **the source** the corrections were made against, taken when
the work begins, and **the resolved transcript** materialized when it is
published. Everything between them lives in the database.

### Approving is the only positive action, and what is stored is a count

A person working on a span does one of two things: they fix the text, or they
leave it because it is already right. **Both end in the same act** — approving
whatever text is there when they move on.

What the record keeps per span is therefore not a state but a number: **how many
people have approved the text that is there right now.** The required count is
configurable per catalog and defaults to two. One person mishears, skims, or is
tired; two people independently content with the same exact words is the quality
bar, and that is the whole of the two-person rule.

Nothing caps the number of people who may look at a span. More eyes on a
difficult passage are welcome, whether to help or to settle an argument, and
approvals beyond the required count are simply surplus. What extra people cannot
do is **outvote a disapproval**: the rule below is that a live disapproval
blocks regardless of how many approvals accumulate around it. Settling a
disagreement means the objector is persuaded or the text changes, never that
enough other people disagreed with them. Anything else would be adjudication by
vote, which is exactly what the next section declines to build.

Approvals are bound to a hash of the text they approve. If someone rewrites a
span, earlier approvals no longer describe what is there — nobody approved words
they never saw — so they stop counting by hash mismatch rather than by deletion,
and the history of who approved what survives.

The count is of **distinct people**. Writing an edit is itself your approval of
it, so nobody reaches the required number alone by coming back to their own work
later. And because the source snapshot is immutable, the machine's original
wording is recoverable for ever: restoring a span somebody mangled is an
ordinary edit, not a special operation.

The three words the tool may use for that count are labels over it, not stored
state:

| label | means | what it controls |
| --- | --- | --- |
| machine | zero approvals — untouched | nothing |
| reviewed | one approval | nothing |
| verified | the required number of approvals | a transcript may be published when every span is verified |

**Only the full count gates anything, and it gates exactly one thing:
publication.** The other two values control nothing at all; they are a progress
readout, driving the coverage figure a reader sees and telling a corrector where
the work has got to.

Because the labels are a rendering of a number, the tool is free to show the
number instead — "one of two" on a span, "812 of 3140" on a recording — and
probably should, rather than teaching anyone new vocabulary. The firm rule
either way is that **nothing may ever be gated on the middle value**. The moment
something is, the label starts doing work of its own and can drift from the
count it exists to describe.

A reader sees none of this. Nothing from a transcript reaches the reading
surface until every span is verified and the transcript is published, so the
counts are visible to correctors and to the progress figure, not to a `čtenář`
waiting for the document.

**Nothing leaves the correction surface before publication.** Corrections in
progress are visible only to correctors; search, agents and readers keep the
machine transcript until the whole transcript is published. Holding
`correct_transcripts` is therefore not the power to change what anyone else
sees: it is access to a tool. This is what makes it safe to hand the permission
out widely, and it has to hold whatever the roles look like.

### Four actions, and only one of them blocks

Everyone working on a transcript has the same four actions, whichever pass they
are on: **change** the text, **comment**, **approve**, **disapprove**.

A **comment** is a thread on the side, anchored to a span, the way comments work
in a shared document. It exists so that discussion has somewhere to live and
survives as a record of it. **A comment does not block publication.** If it did,
people would weigh whether a remark is worth holding up the document and would
stop making them, which loses the communication the comment was for. Threads are
resolved as housekeeping, not as a gate, and a published transcript may carry
open ones.

A **disapproval** is the blocking signal, and it has to be an unambiguous
deliberate act rather than something inferred from the presence of discussion.
It may well be carried on a comment — a thumb down, a minus, some mark on the
thread — or it may be its own control; that is an interface question and it is
not settled here. What is settled is that blocking requires an explicit signal
and that leaving a remark is never one.

Disapproval proposes nothing. It says this is wrong, without requiring the
objector to guess at what was actually said — which is the common case when
listening, and the only action cheap enough to take without stopping the audio.

It uses the same hash binding as an approval:

- If the text is rewritten, the disapproval stops applying, exactly as an
  approval does. The new text starts clean at one approval, and the objector
  reads it and either approves or disapproves again.
- If the text is not rewritten, the span carries an approval and a disapproval
  **on the same words**. That is the disagreement, recorded and visible: one says
  yes, one says no, about this exact text.

A span is publishable when it carries the required approvals and **no live
disapproval**. A disapproval is cleared only by the objector approving the
current text, or by the text changing underneath it.

The comment and the disapproval it may ride on have **different lifetimes**, and
this is deliberate. The disapproval lapses when the text changes, because the
objection was to particular words. The comment does not, because it is anchored
to the span rather than to the text: somebody writes "I think that is a village,
not a surname," the text is edited in response, and it would be perverse for the
edit to destroy the thread that prompted it. The reasoning persists; the
objection has to be made again against the new words.

**There is no adjudication.** A disapproved span stays blocked until the people
involved agree. This is deliberately an opening to deadlock, and it is accepted
as the starting premise: people need to agree in order to continue.

Two things make that premise survivable at the size it is starting at. Most real
disagreement comes from unclear audio rather than from two people confidently
hearing different intelligible words, and for that the route below — agreeing
the passage is unintelligible — is already a resolution that publishes. What is
left with no exit is audible speech that two people each read differently and
neither will move on, which between two people who can talk to each other is a
conversation rather than a system problem.

At twenty correctors who do not know each other it will not be. Adjudication —
someone with `publish_transcript` deciding, that act supplying the approvals,
available only on a span whose history shows a real dispute, and counted so a
transcript published with forty of them says something — is the shape the answer
will take. It is deferred, not rejected. Revisit it when the corps grows beyond
people who can settle it by talking.

### Passages nobody can make out

Where nobody can make out what was said, the corrector **clears the text** and
records that the span is unintelligible. The machine's guess is discarded rather
than kept: a plausible-looking wrong sentence is worse than an acknowledged gap,
because a reader can detect the gap and cannot detect the error.

- The span stays. It keeps its time range and simply holds no text, so spans
  still tile the timeline without gaps and citations still resolve.
- It needs the same approvals as any other span. Two people agreeing that nobody
  can make it out is an editorial statement like any other, so this is not an
  exception to the rule — it is an ordinary edit whose result happens to be
  empty. That is also what keeps the publication gate reachable for recordings
  with bad audio, which are exactly the ones that most need a person.
- Word timings inside such a span are gone, which is correct: we do not know
  when anything was said.
- The fact that the span was unintelligible, and any comment about it, is
  **correctors-only metadata and does not travel**. It stays in the database. The
  sidecar carries an empty span and nothing else, so chunking, search and MCP see
  a segment with no text and treat it as nothing. What consumes text finds no
  text.

A reader of a published transcript therefore sees a gap where such a span was:
the rendered `txt`, `srt` and `vtt` show nothing at all, with no bracketed
marker standing in. Keep it simple until it proves to be a problem for real
readers, and solve it then.

That last point works because **publication is what makes empty unambiguous.** A
transcript can only be published when every span is resolved, so an empty span in
a published transcript can only mean that two people agreed nothing intelligible
is there. The context supplies the meaning and a marker would be redundant, which
also keeps the sidecar a plain canonical transcript with nothing extra for any
consumer to understand.

Machine transcripts support this by essentially never containing empty segments:
`transcribe_qwen3_asr.py` drops them outright, and `transcribe_nemo.py` emits
them but records `segment_text_empty` as a defect reason. One consequence follows
for whoever writes validation over the published sidecar: an empty span **there**
is intentional, and a check copied from the transcription side will fire on every
corrected transcript that contains one.

### Every pass is the same surface

There is no first-pass tool and second-pass tool. Every pass presents the same
screen and the same four actions, and what differs between them is only what is
already on the document when a person arrives: the first meets machine text, the
second meets corrections and approvals, a third meets open threads and
disagreements. Nobody switches modes and nobody learns a second keyboard.

That is what makes the later passes cheap, which is what makes a two-person rule
affordable at all. A reviewer follows one continuous text with the audio running
and acts only where something needs it — and the acts available are the same ones
the first pass used.

Corrections are shown in a distinct colour so that a later pass can read straight
through as though it were the original text while still seeing where a person has
already been. A span carrying a live disagreement is marked likewise. Colour
carries orientation only: it says the text was changed, never who changed it.

One safeguard against rubber-stamping survives this: **an approval cannot be
recorded for audio the player has not actually played.** The other one the
earlier design had — hiding from a reviewer who worked on the span before them —
is gone, because named discussion threads and anonymity cannot both exist and
discussion is worth more. That leaves the played-audio requirement carrying the
weight on its own, which is worth knowing when it comes to be built.

### What an edit does to word timings

Word timings are a reading convenience; **segment boundaries are load-bearing**,
because they are what citations, retrieval chunks, subtitles and MCP URLs are
built from.

Within a span, an edit is reconciled by a word-level diff. Words that did not
change keep their exact timings. Changed runs are redistributed proportionally
across the interval bounded by the nearest unchanged words on either side; where
that interval is degenerate, the redistribution borrows from those neighbours.
Words a person wrote carry no `confidence`, because no model proposed them, and
redistributed timings are marked as estimated rather than measured.

The reconciliation belongs to the server, not to the client, so that every
client and every future tool produces the same result and the rule can be tested
directly.

### Segment boundaries never move

A span's boundaries are the machine's and stay the machine's. There is no
splitting, no merging, no dragging. Correction changes text inside a fixed
tiling of the timeline, which keeps the invariant that spans cover the recording
without gaps or overlaps true by construction, and keeps every citation
resolvable without anything having to be checked.

This is a deliberate simplification and it has a cost. ASR segmentation is often
wrong — a sentence cut in half, two speakers run together — and none of that
gets fixed. A sentence broken across two spans stays broken across two spans.

What remains possible, because it is only text: a corrector can move a word from
the end of one span to the start of the next by editing both. The words end up
attributed to the adjacent span's time range, which the timing reconciliation
below absorbs approximately rather than exactly. That is a clumsy substitute for
a real split and it is accepted as one.

Splitting and merging can be added later without invalidating anything decided
here, because they only ever recombine boundaries that already exist. Starting
without them is what keeps the first version small.

### Correction is its own surface

Correction lives on its own page rather than as extra controls on the recording
page. The reading page serves people who are listening; the correction page
needs the transcript to be the whole screen, a different keyboard model, a
different permission, and data the reading page does not load.

The player is already a controlled component and already supports playing an
excerpt and stopping at a chosen time, which is exactly the segment-playback
primitive this needs. Two things it does not support: being paused from outside,
and keyboard transport while focus is in a text field — its shortcuts
deliberately stand down inside inputs. The correction page therefore owns its
own transport, and the player gains an imperative handle. That is the only
change required to an existing component.

The timeline mechanics needed for a progress-and-navigation ribbon — tick
spacing, active-item lookup, playhead interpolation between the browser's
throttled time updates — already exist inside the backend comparison view and
should be extracted rather than rewritten.

### Edits are recorded as events

The store keeps the history of edits — who, when, from what text to what text,
and how long was spent on the span — not only the resulting text. Comments,
approvals and disapprovals are part of that history. Without this the first real use of the tool
produces an impression; with it, it produces the numbers that decide whether the
two-person rule is worth its cost, how much correction time a minute of audio
costs, and how much two people actually differ.

That history is also what identifies a dispute. A span whose text has oscillated
between variants, or that has accumulated several edits without ever reaching the
required count, **is** a disagreement. Detecting one is a query over data the
design already keeps, not a new concept to store.

### The first version is a pilot, not a small version of the system

The first correction is done by two people — one enrolled corrector and the
person running the project — on one recording, in order to find out what the
workflow actually is. What is being tested is the tool and the flow through it,
not the throughput of a corps.

That matters because several mechanisms described here **do not exist at that
size and should not be built first**: the queue that hands spans to whoever is
free, the leases that stop two people being sent to the same span, and the
anonymity of the second reviewer. With two people on one recording there is no
queue to feed, nothing to lease, and no anonymity to preserve. They are the right
design for a corps and the wrong thing to build for a pilot.

What the pilot does need is the one surface with its four actions, the
unintelligible route, and a way to stop in the middle of a three-hour recording
and resume.

### Two people on one span

Once there is a corps, the queue of spans awaiting a second opinion exists
precisely to send several people to the same span, so simultaneous work on one is
the main flow rather than an edge case. It is then the default view for a
corrector — the spans waiting for a second opinion **within the recordings
already under way** — because finishing someone else's work is the cheapest
useful action available.

Every write carries the hash of the text it was based on. If the span has moved
on, the write is refused and the author is shown what is there now. The hash is
already in the model for approvals, so this costs nothing to add and it
prevents the quiet loss that last-write-wins would otherwise produce: a second
editor overwriting text a first was working on, the first's approval voided by
mismatch, and their work visible only in the edit history.

The queue hands out spans under a short lease so two people are not sent to the
same one to begin with. A lease is an ergonomic measure, not a lock: it expires
on its own and the hash check remains the thing that guarantees correctness.

### Publishing and unpublishing

Publication is a deliberate act by a person holding `publish_transcript`, never
an automatic consequence of the last span being verified. A fully verified
transcript sits and waits until somebody says it is ready to be read.

Nothing goes looking for that person. There are no notifications and no "ready
to publish" surface for correctors: a transcript that has reached every span
verified appears in the administrative section for transcript corrections, and
that is the whole mechanism. At this size the people doing the work tell each
other, and building a queue to announce an event that happens a few times a year
would be machinery serving nobody.

**Publishing runs one job**: it materializes the resolved transcript, renders the
format files and refreshes the index, and the transcript is presented as
published only once that job has completed. One job rather than several, because
separate triggers would let the surfaces drift apart, which is the outcome
materialization exists to prevent.

**Unpublishing runs nothing.** It stops the transcript being shown to readers and
moves nothing else: the materialized artifact stays on disk, and the search index
keeps the corrected text. This is consistent with the position that search and
MCP are never gated on publication — the exposure already exists by design, and
after an unpublish what is exposed is the better text rather than the machine
text. Hiding is the safe direction and never needs to wait for a job, so the flag
flips and the reading surfaces revert at once.

**The artifact is a snapshot; the database is the live version.** Publishing
freezes the current state into the artifact, and correction may carry on
afterwards. An edit made to a published transcript therefore changes nothing a
reader sees: the published artifact stands until somebody republishes, exactly
as a published document can have a draft behind it. This is what makes
publication a statement rather than a mode.

Two consequences worth stating:

- Republishing a transcript nobody has touched is free. The artifact and the
  index entry never went anywhere, so it is the flag flipping back. An edit made
  in the meantime forces the job to run again on the way back in — and that edit
  voids its span's approvals, so the transcript cannot be republished until it is
  verified again.
- **Unpublish means "not ready to be read as a document." It does not mean "this
  text must stop being reachable."** If a name is badly wrong, or a speaker asks
  to be taken out, that is a different action with different consequences and it
  must not be smuggled into this one. Nothing here builds it.

### The sidecar is a resolved transcript, not a list of changes

The artifact that crosses into the Python runtime is a **complete transcript in
the canonical schema** — the published transcript, every span verified and
substituted in. It is written at publication and at no other time, and
unpublishing does not remove it.

It lives in its own writable tree, keyed by the generation it resolves against
and then by `audio_hash`, the way posters and sources already have writable
directories of their own. It is not written inside the transcript generation.
[ADR 0002](0002-artifact-generations.md) treats a generation's contents as
published artifacts whose only mutable coordination state is the symlink, so
writing corrections into one would break rollback: repointing the symlink would
leave corrections attached to a generation nobody is reading. Keying by
generation also stops a re-transcription from silently inheriting a sidecar
resolved against a different segmentation.

Making it a diff would put merge logic on both sides of the boundary, where the
two implementations could disagree. As a resolved transcript it needs none: the
export step renders `txt`, `srt` and `vtt` from it exactly as it does from any
transcript, chunking reads it exactly as it reads any transcript,
`readTranscriptFile()` resolves by pointing at its directory, and
`docs/schemas/transcript.schema.json` validates it. Merging lives once, in the
runtime that owns the database.

Beyond the canonical fields it carries only how many approvals each span
carries. Words a person wrote already carry `confidence: null` and an
estimated-timing marker from the reconciliation rule above. Whether a transcript
is published is database state and is not written into the artifact, because the
artifact outlives an unpublish; **the flag is authoritative and the artifact's
existence means nothing on its own.**

One thing the schema does not yet accommodate: `meta.backend` is a closed
enumeration of the five ASR backends, and `meta` requires `model` and
`generation_params`. A resolved transcript has no honest value for any of them.
Either the enumeration gains a value for corrected output, or the sidecar keeps
the originating backend and carries a marker beside it. This has to be decided
before the sidecar can be written, and it is the one place where the claim that
the existing schema validates the artifact unchanged does not hold.

### Scope and what to correct first

Only primary recordings of events are in scope: 198 recordings, 606.7 hours. A
secondary recording is in practice a second microphone on the same speech; it
has its own `audio_hash` and its own timings, so a correction never transfers
between the two. Nothing here addresses them and nothing needs to yet.

At a playback speed of one, two passes over that cannot cost less than 1213
person-hours, and realistically cost several times that. Complete coverage of
the **corpus** is therefore not a goal. Complete coverage of any **recording**
that is taken on is not optional: a half-checked beseda is of no use to a reader
and can never be published, so a recording is gone through from end to end or not
started.

That settles what the two signals the system already has are for, and it is not
selecting spans. Low `confidence` directs **attention inside a pass** — it is
where the tool pauses and waits rather than playing on — and it is read with
reserve, because a model's certainty is not the same as being right. Citation
telemetry and search logs choose **which recording to take next**, not which
parts of one to bother with.

Scattering corrections across the corpus at low-confidence spots would improve
search and publish nothing, which is the opposite of the trade this design makes.

An average recording runs over three hours, so the unit a person commits to in
one sitting cannot be a recording. Progress is tracked and resumed inside one.

### An editorial policy precedes the code

Two correctors who disagree about whether to keep "ehm", whether to remove false
starts, how to punctuate, whether to write numbers as words, and how to mark
inaudible passages will register disagreement about spans where nobody actually
misheard anything. With disapprovals blocking publication and no adjudication to
break them, that is not a cosmetic problem: it stalls the document. A short
written convention, visible inside the correction tool, is a prerequisite rather
than documentation written afterwards.

## Consequences

- Done means two things at two levels, and the record keeps them apart. A
  **span** is done when its current text carries the required approvals and no
  live disapproval. A **transcript** is done when every span is and a person has
  published it, which is a stored state alongside `CatalogEntry.isPublished` and
  `CatalogEvent.released`. Every span verified is the invariant that permits
  publication, not the publication itself. Until then a derived coverage figure
  stands for the transcript, and it is computed from the spans rather than stored
  beside them, so the two can never disagree.
- Keeping corrections apart until publication spares every reader a resolution
  rule. Partially corrected text never leaves the correction surface, so neither
  `loadTranscript()` — on the recording page, in the comparison view and behind
  MCP's `get_transcript` — nor `readTranscriptFile()` on the download and export
  paths has to merge anything. Each points at the materialized artifact of a
  published transcript, which is already whole, or at the default backend's
  machine transcript when there is none. What each still needs is to know whether
  a transcript is published and where its artifact is.
- Retrieval needs no notion of correction state. Publishing changes the
  transcript fingerprint, and the existing incremental per-`audio_hash` sync
  already adds, refreshes and prunes on that basis. Unpublishing changes nothing
  in the index by decision, so there is no reverse path to build.
- Corrections must reach the Python side without either runtime reaching into
  the other's storage, which [ADR 0004](0004-system-boundaries.md) forbids. At
  publication they are materialized into the writable tree described above, and
  the export and chunking steps read it from there.
- That materialization is also what answers the download path, so the two are
  one mechanism rather than two. Once the resolved transcript is materialized and
  the export step renders the format files from it, `readTranscriptFile()`
  resolves by pointing at the corrected artifact and needs no renderer of its own.
  The alternative — rendering formats on the fly in the web app — would duplicate
  subtitle rendering that already exists in Python and put it on the wrong side of
  the boundary. It also means downloads and search become correct at the same
  moment, both driven by materialization, rather than drifting apart.
- Before a transcript has ever been published no surface differs from any other:
  the transcript view, its download, the bulk export, web search and every MCP
  tool serve the machine transcript, and corrections in progress are visible only
  inside the correction surface. **After an unpublish they do differ** — the
  reading surfaces show the machine transcript while search and MCP continue to
  serve the corrected text. That is the accepted consequence of unpublish moving
  nothing but a flag.
- The interval between publishing and the corrected text being available is
  hidden rather than accepted: the transcript is presented as published only once
  the job has materialized, rendered and indexed it, so no surface ever finds a
  published transcript without its artifact or its index entry. Formats are never
  rendered on the fly in the web app, and the job is never a person remembering
  to run `just catalog export-transcripts`.
- That job is a dependency, not existing machinery. Prefect runs in production
  and owns one flow today, deep search, which the web application already starts
  through the jobs API. Materializing, rendering and reindexing on publication is
  a second flow with a second deployment, and the publish handler has to call the
  jobs API the way the deep-search route does. Until both exist, nothing can be
  published.
- Corrections are never disturbed by re-transcription, because they are
  anchored to a frozen snapshot of the transcript they were written against. No
  span is relocated, none is marked stale, and nothing is ever applied to text it
  was not written for. Taking up a newer transcription means starting the
  recording again against a new snapshot, deliberately.
- Speaker attribution is a separate concern. Transcripts carry no speaker names;
  the diarization overlay distinguishes turns without identifying who is
  speaking. Attributing speech is a later phase using the same span mechanism
  rather than part of text correction.
- Publication gates the reading surfaces only: the transcript view, its download
  and the bulk export. Search and MCP are never gated on it, so a reader can
  obtain an unpublished transcript's machine text by asking an agent for it. That
  asymmetry is the documented MCP position — the transcript is a source there,
  not a document — and is not to be closed by gating `get_transcript`.
- Until a transcript is published a reader is shown how far checking has got,
  rather than an empty panel or the machine text. That figure is **duration
  checked against total duration**, not spans counted, because spans run from a
  few seconds to a minute and a count of them would misrepresent the real
  position. It is the only thing a `čtenář` learns about a transcript in
  progress.
- The correction page is desktop-first. Typing against running audio on a phone
  is not a workflow worth pretending to support, though confirming a span may be.
- The reward that motivates correction arrives with the first published
  transcript, not with the promotion of the listeners. Publication replaces the
  machine text everywhere at once, and every active account holds the MCP tools,
  so the answers an agent gives all 81 of them improve immediately. Reading the
  transcript as a document still waits for someone to make the listeners readers,
  but correction stops being work without an audience the moment one recording is
  finished.
- Nothing here is cheap. One recording averages just over three hours, so two
  passes over the first one is six person-hours at the theoretical floor and
  realistically fifteen to twenty-five. Nothing improves for anyone until that
  first transcript is published. This is accepted as the cost of starting.

## Settled points

- **Corrections are stored as events, not only as final text.**
- **The two-person rule applies to the current exact text**; changing the text
  voids prior approvals and the span returns to needing them again.
- **The verb is publish, and unpublish moves only a flag.**
- **What is stored per span is a count, not a state**, and nothing may ever be
  gated on the middle value.
- **Only a disapproval blocks; a comment never does.** Blocking takes an
  explicit signal, and an open thread is not one.
- **There is no adjudication and no outvoting.** People have to agree. This is a
  starting premise to revisit when the corps outgrows talking to each other.
- **Every pass is the same surface with the same four actions** — change,
  comment, approve, disapprove.
- **An unintelligible passage is cleared, not guessed at**, and the fact that it
  was unintelligible does not leave the database.
- **Correction works against a frozen snapshot of the machine transcript**, so
  re-transcription can never disturb work in progress or a publication.
- **Span boundaries never move.** No splitting, no merging, in this version.
- **The artifact is a snapshot and the database is the live version**, so an
  edit to a published transcript changes nothing until somebody republishes.
- **The system is tried before it is opened.** Two or three primary recordings,
  two correctors each, before listeners are promoted to readers.

## Open questions

- **How `meta.backend`, `meta.model` and `meta.generation_params` are filled for
  a resolved transcript**, per the sidecar section above. This one blocks the
  sidecar being written at all.
- **How a disapproval is expressed in the interface** — a mark on a comment
  thread, or a control of its own. The rule it has to satisfy is settled: an
  explicit deliberate signal, never inferred from a thread existing.
- **Whether a transcript carrying disagreements is shown as stalled** somewhere
  above the span, so that a document one objection away from publishable does not
  sit unnoticed, or whether the count in the correction surface is enough.
- **The correction data model** — spans, approvals, disapprovals, comments and
  the edit log — is not in this record and has to be written before any of it is
  built. It is the next thing to write.
- **The editorial convention** correctors follow, which this record has called a
  prerequisite since the first draft and which nobody has written.

Closed since the first draft: what the second pass produces (nothing special —
every pass offers the same four actions); how an unintelligible passage is marked
(the text is cleared and the fact stays in the database); and whether
re-transcription disturbs corrections (it cannot, because the source is frozen).
