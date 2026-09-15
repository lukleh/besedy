# ADR 0006: Human transcript correction

- **Status:** Proposed
- **Date:** 2026-09-15
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
  MCP, and `readTranscriptFile()` for the transcript download route and the
  bulk export.
- Diarization is already merged into the reading view as an overlay resolved at
  render time, from a separate artifact.
- Agent-facing guidance already tells an agent to qualify a quotation when a
  passage looks badly transcribed, which is a workaround for the absence of any
  way to fix it.

## Decision

### Corrections are database records; artifacts stay immutable

Corrections are authoritative PostgreSQL rows. Transcript JSON on disk is never
rewritten, which keeps [ADR 0002](0002-artifact-generations.md) intact and
follows [ADR 0003](0003-web-catalog-projection.md), where user-authored state is
authoritative in PostgreSQL rather than reconstructed from pipeline output.

### The span is the unit of work; the transcript is the unit of release

Per [ADR 0005](0005-catalog-permission-model.md), correction substitutes at the
level of the **span**. A recording has one transcript in which each span is
either machine output or verified text, and a partly corrected recording is the
normal state for years rather than a transitional one.

What that improving text feeds is search and agents, continuously and without
ceremony. What it does not do is open the transcript for reading: that happens
once, when every span has been verified and a person **releases** the transcript.
Reading end to end is an editorial statement about the whole document and cannot
be made span by span.

So the work is granular and the publication is not, and the record has to keep
both. A coverage figure derived from the spans is what stands for a transcript
until it is released.

### The unit is a segment of the default backend, anchored by time

Correction happens on one backend — the configured default — because correcting
nine variants of the same speech is not work anyone will do. The verified layer
that results is keyed by **time**, not by backend: it records what was said
between two moments, and the machine transcripts become proposals underneath it.

Because segments carry no identifiers, a span is anchored by its **time range
plus a hash of its source text**. The segment index is stored as a hint, never as
the identity. Rows are created lazily on the first human touch; an untouched span
has no row.

### Span state, attestation, and what verification means

A span carries its current text and a status. Verification is reached when
**two distinct people have vouched for that exact text**. Whoever writes a
correction vouches for it by writing it, so a corrected span needs one further
attestation and an untouched machine span needs two. The required count is
configurable per catalog and defaults to two.

Three states are visible, not two:

| State | Reached by |
| --- | --- |
| machine | nobody has touched the span |
| reviewed | one person has vouched for the current text |
| verified | the required number of people have |

The middle state exists because a single pass by one person already removes most
nonsense, and with a small group it would otherwise be work that never counts
for anything.

**Only `verified` spans leave the correction surface.** A span one person has
corrected still reads as machine output to search, to agents and to the eventual
release, until a second person agrees. Holding `correct_transcripts` is therefore
not the power to change what anyone else sees: it is access to a tool, and the
second attestation is the control. This is what makes it safe to hand the
permission out widely, and it has to hold whatever the roles look like.

A reader sees none of this. Nothing from a transcript reaches the reading surface
until every span is verified and the transcript is released, so the span states
are visible to correctors and to the progress figure, not to a `čtenář` waiting
for the document.

Attestations are bound to a hash of the text they vouch for. Editing the text
therefore voids them by mismatch rather than by deletion, and the history of who
vouched for what survives.

### The second pass is a different activity from the first

The first pass corrects: it stops at each span, and the tool plays that span and
waits. The second pass confirms: audio runs continuously and the reviewer
intervenes only when something is wrong. Making the second pass cheap is what
makes a two-person rule affordable at all.

Two safeguards against rubber-stamping, both cheap: an attestation cannot be
recorded for audio the player has not actually played, and the second reviewer is
not shown who worked on the span before them.

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
page. The reading page serves people who are listening; the correction page needs
the transcript to be the whole screen, a different keyboard model, a different
permission, and data the reading page does not load.

The player is already a controlled component and already supports playing an
excerpt and stopping at a chosen time, which is exactly the segment-playback
primitive this needs. Two things it does not support: being paused from outside,
and keyboard transport while focus is in a text field — its shortcuts
deliberately stand down inside inputs. The correction page therefore owns its own
transport, and the player gains an imperative handle. That is the only change
required to an existing component.

The timeline mechanics needed for a progress-and-navigation ribbon — tick
spacing, active-item lookup, playhead interpolation between the browser's
throttled time updates — already exist inside the backend comparison view and
should be extracted rather than rewritten.

### Edits are recorded as events

The store keeps the history of edits — who, when, from what text to what text,
and how long was spent on the span — not only the resulting text. Without this
the first real use of the tool produces an impression; with it, it produces the
numbers that decide whether the two-person rule is worth its cost, how much
correction time a minute of audio costs, and how much two people actually differ.

### Two people on one span

The queue of spans awaiting a second opinion exists precisely to send several
people to the same span, so simultaneous work on one is the main flow rather
than an edge case.

Every write carries the hash of the text it was based on. If the span has moved
on, the write is refused and the author is shown what is there now. The hash is
already in the model for attestations, so this costs nothing to add and it
prevents the quiet loss that last-write-wins would otherwise produce: a second
editor overwriting text a first was working on, the first's attestation voided by
mismatch, and their work visible only in the edit history.

The queue hands out spans under a short lease so two people are not sent to the
same one to begin with. A lease is an ergonomic measure, not a lock: it expires
on its own and the hash check remains the thing that guarantees correctness.

### The sidecar is a resolved transcript, not a list of changes

The artifact that crosses into the Python runtime is a **complete transcript in
the canonical schema** — machine text with verified spans already substituted in.

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
`docs/schemas/transcript.schema.json` validates it without a new schema being
written. Merging lives once, in the runtime that owns the database.

Beyond the canonical fields it carries only what a reader must be told:
which spans are verified, and by how many attestations. Words a person wrote
already carry `confidence: null` and an estimated-timing marker from the
reconciliation rule above.

### Scope and what to correct first

Only primary recordings of events are in scope: 198 recordings, 606.7 hours.

At a playback speed of one, two passes over that cannot cost less than 1213
person-hours, and realistically cost several times that. Complete coverage is
therefore not a goal. Work is directed by two signals the system already has:
low `confidence`, and which passages are actually being read, from MCP tool
telemetry and search logs.

An average recording runs over three hours, so the unit a person commits to
cannot be a recording. Progress is tracked and resumed inside one, and the
default view for a corrector is the queue of spans waiting for a second opinion,
because finishing someone else's work is the cheapest useful action available.

### An editorial policy precedes the code

Two correctors who disagree about whether to keep "ehm", whether to remove false
starts, how to punctuate, whether to write numbers as words, and how to mark
inaudible passages will register disagreement about spans where nobody actually
misheard anything. A short written convention, visible inside the correction
tool, is a prerequisite rather than documentation written afterwards.

## Consequences

- Done means two things at two levels, and the record keeps them apart. A **span**
  is done when its current text carries the required attestations. A
  **transcript** is done when every span is and a person has released it, which
  is a stored state alongside `CatalogEntry.isPublished` and
  `CatalogEvent.released`. Every span verified is the invariant that permits the
  release, not the release itself. Until then a derived coverage figure stands
  for the transcript, and it is computed from the spans rather than stored beside
  them, so the two can never disagree.
- Resolving "corrected where a span has been verified, original elsewhere"
  belongs in
  `lib/transcript`, where both `loadTranscript()` and `readTranscriptFile()`
  live. The first covers the recording page, the comparison view and MCP; the
  second covers the transcript download route and the bulk export. Changing
  only the first would leave downloads and the export serving machine text.
- The two readers need different work, because they read different things.
  `loadTranscript()` parses `transcript.json` and can pick a different source.
  `readTranscriptFile()` returns `transcript.<format>` as bytes, and no corrected
  `json`, `txt`, `srt` or `vtt` exists anywhere: the format files are rendered by
  the pipeline's export step. Resolution on that side therefore means producing
  the formats from corrected text, not choosing a different file.
- Retrieval needs no notion of correction state. A corrected transcript changes
  the transcript fingerprint, and the existing incremental per-`audio_hash` sync
  already adds, refreshes and prunes on that basis.
- Corrections must reach the Python side without either runtime reaching into the
  other's storage, which [ADR 0004](0004-system-boundaries.md) forbids. They are
  materialized into the writable tree described above, and the export and chunking
  steps read it from there.
- That materialization is also what answers the download path, so the two are one
  mechanism rather than two. Once the resolved transcript is materialized and the
  export step renders the format files from it, `readTranscriptFile()` resolves
  by pointing at the corrected artifact and needs no renderer of its own. The
  alternative — rendering formats on the fly in the web app — would duplicate
  subtitle rendering that already exists in Python and put it on the wrong side
  of the boundary. It also means downloads and search become correct at the same
  moment, both driven by materialization, rather than drifting apart.
- The split between live and trailing reads does not follow surfaces, it follows
  readers, and MCP falls on both sides of it. `get_transcript` goes through
  `loadTranscript()` and is live; `search_transcripts` and
  `find_transcript_mentions` read the retrieval bundle and trail, exactly as the
  download route, the bulk export and the catalog's own search do. An agent can
  therefore quote a corrected passage from one tool while another still returns
  the machine wording for the same moment.
- Because of that, accepting a correction triggers **one** job that both renders
  the format files and refreshes the index. Two separate triggers would let the
  surfaces drift apart from each other rather than merely lag the page, which is
  the outcome materialization exists to prevent. The lag itself is accepted and
  is not to be closed by rendering formats in the web app; it is bounded by that
  job and never by someone remembering to run `just catalog export-transcripts`.
- That job is a dependency, not existing machinery. Prefect runs in production
  and owns one flow today, deep search, which the web application already starts
  through the jobs API. Transcript rendering and reindexing on acceptance is a
  second flow with a second deployment, and the acceptance handler has to call
  the jobs API the way the deep-search route does. Until both exist, corrections
  reach the page and `get_transcript` and go no further.
- Corrections are anchored to text that re-transcription can change. On a
  mismatch the span is relocated by time overlap and text similarity; a confident
  relocation is applied and recorded, and anything less leaves the span marked
  stale for a person to resolve. Corrections are never applied silently to text
  they were not written against.
- Speaker attribution is a separate concern. Transcripts carry no speaker
  names; the diarization overlay distinguishes turns without identifying who is
  speaking. Attributing speech is a later phase using the same span mechanism
  rather than part of text correction.
- Releasing gates the reading surfaces only: the transcript view, its download
  and the bulk export. Search and MCP are never gated on it, so a reader can
  obtain unreleased text by asking an agent for it. That asymmetry is the
  documented MCP position — the transcript is a source there, not a document —
  and is not to be closed by gating `get_transcript`.
- Until a transcript is released a reader is shown how far checking has got,
  rather than an empty panel or the machine text. That figure is the only thing a
  `čtenář` learns about a transcript in progress.
- The correction page is desktop-first. Typing against running audio on a phone
  is not a workflow worth pretending to support, though confirming a span may be.
- Until listeners become readers, corrected transcripts have an audience of three
  accounts. The reward that motivates correction — a verified passage quoted
  without a caution about machine transcription — only exists once that
  promotion happens.

## Settled points

- **Corrections are stored as events, not only as final text.**
- **The two-person rule applies to the current exact text**; changing the text
  voids prior attestations and the span returns to needing them again.
- **The system is tried before it is opened.** Two or three primary recordings,
  two correctors each, before listeners are promoted to readers.

## Open questions

- Whether verification should also be reachable for spans nobody edits by a
  single person confirming a whole run at once, or whether every span must be
  attested individually.
- Whether the correction queue is offered per recording, per event, or purely as
  a stream of spans ranked by confidence and citation frequency.
- How a corrector marks an inaudible or disputed passage so that the marker is
  machine-readable rather than a convention inside free text.
