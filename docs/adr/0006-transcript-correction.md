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
both. A coverage figure derived from the spans is what stands for a transcript
until it is published.

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

### Vouching is the only action, and what is stored is a count

A person working on a span does one of two things: they fix the text, or they
leave it because it is already right. **Both are the same act** — vouching for
whatever text is there when they move on. That is the only positive action in
the model.

What the record keeps per span is therefore not a state but a number: **how many
people have vouched for the text that is there right now.** The required count
is configurable per catalog and defaults to two. One person mishears, skims, or
is tired; two people independently content with the same exact words is the
quality bar, and that is the whole of the two-person rule.

Attestations are bound to a hash of the text they vouch for. If someone rewrites
a span, earlier vouches no longer describe what is there — nobody vouched for
words they never saw — so they stop counting by hash mismatch rather than by
deletion, and the history of who vouched for what survives.

The three words the tool may use for that count are labels over it, not stored
state:

| label | means | what it controls |
| --- | --- | --- |
| machine | zero vouches — untouched | nothing |
| reviewed | one vouch | nothing |
| verified | the required number of vouches | a transcript may be published when every span is verified |

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

### Disagreement is a contest, and a contest blocks

Vouching alone cannot express disagreement. Without a second action, the only
way to disagree is to overwrite the other person's text, which makes a genuine
dispute indistinguishable from an ordinary improvement and lets two people
oscillate forever.

A **contest** is the mirror of a vouch and uses the same machinery: it is bound
to the hash of the text it objects to, and it proposes nothing. It says this is
wrong, without requiring the objector to guess at what was actually said — which
is the common case when listening, and the only action cheap enough to take
without stopping the audio.

Everything else follows from the hash binding that attestations already use:

- If the text is rewritten, the contest stops applying, exactly as a vouch does.
  The new text starts clean at one vouch, and the objector reads it and either
  vouches or contests again.
- If the text is not rewritten, the span carries a vouch and a contest **on the
  same words**. That is the disagreement, recorded and visible: one says yes,
  one says no, about this exact text.

A span is publishable when it carries the required vouches and **no live
contest**. A contest is cleared only by the objector vouching for the current
text, or by the text changing underneath it. A contest may carry a comment, so
that the two people can talk to each other rather than exchange silent edits.

**There is no adjudication.** A contested span stays blocked until the people
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
someone with `publish_transcript` deciding, that act supplying the attestations,
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
- It needs the same vouches as any other span. Two people agreeing that nobody
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

### The second pass is a different activity from the first

The first pass corrects: it stops at each span, and the tool plays that span and
waits. The second pass runs with the audio continuous, the reviewer intervening
only when something is wrong. Making the second pass cheap is what makes a
two-person rule affordable at all.

What that pass **produces** is now open. The design above gives a listening
reviewer a one-key action that costs nothing — contest — which means a continuous
pass may produce a list of objections for a later pass to resolve rather than
producing verification directly. That is a different system from one where
passive listening attests to everything it goes past, and it decides what the
tool looks like. See the open questions.

Two safeguards against rubber-stamping, both cheap: an attestation cannot be
recorded for audio the player has not actually played, and the second reviewer is
not shown who worked on the span before them. The second of these does not apply
to the pilot below, where there are two people and both know it.

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

### Segment boundaries change only by recombination

Text edits never move a span's boundaries. A span may be **split at a word
boundary**, using the timing the transcript already records, and adjacent spans
may be **merged**. Both operations only recombine boundaries that already exist,
so the invariant that spans tile the recording's timeline without gaps or
overlaps survives, and citations stay resolvable. Arbitrary boundary dragging is
out of scope.

ASR segmentation is frequently wrong — a sentence cut in half, two speakers
merged — so split and merge belong in the first version, not a later one.

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
and how long was spent on the span — not only the resulting text. Vouches and
contests are part of that history. Without this the first real use of the tool
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

What the pilot does need is the two passes, the vouch, the contest, the
unintelligible route, split and merge, and a way to stop in the middle of a
three-hour recording and resume.

### Two people on one span

Once there is a corps, the queue of spans awaiting a second opinion exists
precisely to send several people to the same span, so simultaneous work on one is
the main flow rather than an edge case. It is then the default view for a
corrector — the spans waiting for a second opinion **within the recordings
already under way** — because finishing someone else's work is the cheapest
useful action available.

Every write carries the hash of the text it was based on. If the span has moved
on, the write is refused and the author is shown what is there now. The hash is
already in the model for attestations, so this costs nothing to add and it
prevents the quiet loss that last-write-wins would otherwise produce: a second
editor overwriting text a first was working on, the first's attestation voided by
mismatch, and their work visible only in the edit history.

The queue hands out spans under a short lease so two people are not sent to the
same one to begin with. A lease is an ergonomic measure, not a lock: it expires
on its own and the hash check remains the thing that guarantees correctness.

### Publishing and unpublishing

Publication is a deliberate act by a person holding `publish_transcript`, never
an automatic consequence of the last span being verified. A fully verified
transcript sits and waits until somebody says it is ready to be read.

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

Two consequences worth stating:

- Republishing a transcript nobody has touched is free. The artifact and the
  index entry never went anywhere, so it is the flag flipping back. Only an edit
  made while unpublished forces the job to run again on the way back in — and
  that edit voids its span's attestations, so the transcript cannot be
  republished until it is verified again.
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

Beyond the canonical fields it carries only how many attestations each span
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
misheard anything. With contests blocking publication and no adjudication to
break them, that is not a cosmetic problem: it stalls the document. A short
written convention, visible inside the correction tool, is a prerequisite rather
than documentation written afterwards.

## Consequences

- Done means two things at two levels, and the record keeps them apart. A
  **span** is done when its current text carries the required attestations and no
  live contest. A **transcript** is done when every span is and a person has
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
- Corrections are anchored to text that re-transcription can change. On a
  mismatch the span is relocated by time overlap and text similarity; a confident
  relocation is applied and recorded, and anything less leaves the span marked
  stale for a person to resolve. Corrections are never applied silently to text
  they were not written against.
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
  rather than an empty panel or the machine text. That figure is the only thing a
  `čtenář` learns about a transcript in progress.
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
  voids prior attestations and the span returns to needing them again.
- **The verb is publish, and unpublish moves only a flag.**
- **What is stored per span is a count, not a state**, and nothing may ever be
  gated on the middle value.
- **A contest blocks and there is no adjudication.** People have to agree. This
  is a starting premise to revisit when the corps outgrows talking to each other.
- **An unintelligible passage is cleared, not guessed at**, and the fact that it
  was unintelligible does not leave the database.
- **The system is tried before it is opened.** Two or three primary recordings,
  two correctors each, before listeners are promoted to readers.

## Open questions

- **What the second pass produces.** Continuous listening with contest as the
  cheap in-flight action may mean the second pass yields a list of objections
  rather than verification, moving verification to a third pass. The alternative
  is that passive listening attests to everything it passes, which is affordable
  but rubber-stampable. This decides the shape of the tool and is the largest
  thing still open.
- **What a reader sees where a span was cleared.** A gap in the rendered `txt`,
  `srt` and `vtt`, or a visible marker. A marker would have to be literal text in
  the span rather than metadata, which would put it in front of MCP and search.
- **Whether a contest is visible above the span.** Whether a transcript carrying
  contests is shown as stalled so that somebody notices, or whether the blockage
  is only apparent to whoever opens the span.
- **How `meta.backend`, `meta.model` and `meta.generation_params` are filled for
  a resolved transcript**, per the sidecar section above.
