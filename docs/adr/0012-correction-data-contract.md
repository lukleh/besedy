# ADR 0012: Correction data contract for reuse in model training

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR 0006](0006-transcript-correction.md) (span boundaries, unclear
  speech, playback as recorded fact, guide convention)
- **Canonical references:** [ADR 0006](0006-transcript-correction.md),
  [ADR 0002](0002-artifact-generations.md), [Backends](../backends.md),
  [Data model](../data-model.md)

## Context

Human corrections are expensive and cannot be redone. Once correctors start, the
stored data has to be enough for every later use: publication, search, and
fine-tuning of the project's own ASR models. Export and training code can be
rewritten and rerun at any time. A fact that was not stored while a person worked
can never be recovered.

ADR 0006 was written for publication. Checking it against training on
2026-10-10 and 2026-10-19 found that the data it stores is not enough. The
measurements below were made with the production default backend
(`faster-whisper/large-v3@silero_vad_v6@lang-cs`, 254 recordings, 90,054
segments) and the pinned faster-whisper 1.2.1.

**How the model sees the audio.** The pipeline uses faster-whisper's batched
mode with `without_timestamps=True` and `condition_on_previous_text=False`:

1. Silero VAD finds speech regions. Each region is padded by 400 ms, and gaps
   shorter than 0.8 s are bridged at their midpoint. Speech longer than 30 s is
   split at the last pause.
2. `collect_chunks` packs consecutive regions into model inputs of at most 30 s
   of *speech*. It drops the silence between them and ignores how long that
   silence was in the recording.
3. Each pack ("chunk") is decoded once. It yields one text and one transcript
   segment.
4. With `word_timestamps=True`, `restore_speech_timestamps` shrinks the
   segment to its first and last recognized word.

The VAD regions are stored in every transcript as
`meta.generation_params.transcription_options.clip_timestamps`. Repeating step 2
on them gives exactly as many chunks as there are segments in all 254
transcripts. The model input is therefore recoverable exactly.

**What is wrong with source segments as correction spans.**

- **They miss speech.** Step 4 leaves 8.5 % of VAD speech (57.7 h of 680 h)
  outside every segment. A sample of 60 segments with at least 2 s outside
  found about one in six hiding real dropped sentences. The correction UI plays
  only a span's start to end, so correctors would never hear that speech, and
  published corrections would silently omit it.
- **They can be very long in the recording.** Step 2 can glue speech from
  either side of a long pause into one chunk. The pause between regions inside
  one chunk reached 39 minutes. A corrector cannot tell which part of such a
  window an added word belongs to.
- **They do not match the model input.** A training example built from a
  segment's text and its chunk's audio would teach the model to drop speech.

**What else is missing for training.** The data model also records:

- no structured reason to keep a span out of training;
- no evidence that an approver listened to the span;
- no record of where a revision's text came from;
- no guide revision for individual text revisions;
- no identity for the staged audio the times refer to.

ADR 0006's convention also leaves fillers to each person's judgement, which
gives inconsistent labels. Unclear speech must be disapproved, which blocks
publication of the whole recording for good.

**Verified foundations.** A dry run on 2026-10-10 exercised the whole chain:

1. Random spans from 40 recordings.
2. Audio rebuilt from staged WAV and `clip_timestamps`.
3. LoRA fine-tuning of whisper-large-v3 on the host GPU (3.5 min, 5 GiB peak).
4. Conversion to CTranslate2.
5. Transcription with besedy's own `transcribe_faster_whisper.py`. Word
   timestamps were preserved.

Corrected text needs no timestamps, because inference decodes without timestamp
tokens and the times come from VAD. The archived Opus and AAC files the
correction UI plays share the staged WAV's timeline: cross-correlation on four
recordings found 0 ms offset, at most about 5 ms for Opus.

## Decision

### Three layers: VAD region, chunk, span

- A **VAD region** is one entry of the frozen source's `clip_timestamps`.
- A **chunk** is the group of regions the model decoded together, rebuilt with
  the same rule as `collect_chunks`. It is the unit of training.
- A **span** is the unit of correction. It is a run of consecutive regions inside
  one chunk, split wherever the silence between two regions is at least 1 s. A
  run still longer than 30 s from first region start to last region end is split
  at its longest internal gap, recursively. A run shorter than 2 s is then merged
  into its neighbour in the same chunk, across the shorter gap first, whenever
  the merged run stays within 30 s. Repeat until nothing changes.

Merging short runs only changes how a chunk is divided among correctors. The
chunk, which is the training input, stays the same. Spans of one or two seconds
mostly hold a sentence fragment cut off by a pause, such as "A…", or a sound
without words, and are not worth correcting on their own.

**A span never crosses a chunk boundary.** A corrector hears a contiguous piece
of audio of at most 30 s and writes what is heard in it. The texts of a chunk's
spans, in order, are the exact label for the exact model input.

On the production data of 2026-10-19 (90,461 chunks), this gives 152,623 spans.
All are at most 30 s and the median is 16.5 s. Silence inside a span has a
median of 0.13 s and a 99th percentile of 4.2 s.

Without the merge, 12,666 spans were shorter than 2 s and 3,725 shorter than
1 s. After it, 1,981 and 510 remain; these cannot merge without passing 30 s.
Of the 1 s spans before merging, 77 % had no machine words. Their median
loudness was only 7 dB below the recording's speech, so they are not silence.

Every chunk's spans cover exactly its regions in order. Every VAD region belongs
to exactly one span, so spans cover all detected speech.

This replaces ADR 0006's import of source segments as spans. Boundaries stay
fixed once imported, as before: there is no split, merge or boundary editing.

### What the import stores, once

Starting a workspace stores, in addition to ADR 0006's frozen source copy and
fingerprint:

- **On the workspace:**
  - the segmentation version and its parameters (`chunks-v1`: split gap 1 s,
    maximum 30 s, merge below 2 s);
  - the source chunk count;
  - the identity of the staged audio: path, byte size and SHA-256.
- **On each span:**
  - its chunk ordinal;
  - its first and last region index into the frozen `clip_timestamps`;
  - its speech regions;
  - its start and end (first region start to last region end);
  - the machine words assigned to it, with their times;
  - its initial text, which is those words joined.

A word belongs to the span holding the midpoint of its time. A word whose
midpoint falls into removed silence belongs to the nearest region. Only 1,210
of 4.6 million words do. Splitting at 1 s gaps leaves 338 words straddling a
boundary, measured before the 30 s rule adds its few extra splits. A
segment's text equals its joined words in 98.9 % of segments; the rest differ
only in spacing around hyphens and are matched character by character.

The algorithm has one reference implementation in Python and one in TypeScript.
They share fixtures under `contracts/`, so the web import and the training
export cannot diverge.

**A start is refused** when the frozen source has no `clip_timestamps`, or when
its chunk count differs from its segment count. Falling back to word bounds
would silently bring back the gaps this record closes. **The staged audio of a
recording with a live workspace is protected:** `catalog clean` and
re-staging refuse to replace or delete it.

### Flags describe the audio and do not block publication

A corrector can set flags on a span:

- `unclear`: speech present but not fully intelligible;
- `overlap`: overlapping speakers;
- `other_language`: with an ISO 639-1 code;
- `music_noise`: music or noise over speech;
- `cut_word`: a word cut at the span boundary;
- `exclude_from_training`: with an optional comment.

Flags are immutable set and clear events with an actor and time, plus a current
projection. Flags never affect the done state or publication.

This amends ADR 0006 on unclear speech. A corrector writes what is clear and
sets `unclear` instead of disapproving, so one hard passage no longer keeps a
whole recording from readers. Disapproval remains the way to dispute the text
itself. Empty text still means that nothing was said. There is still no inline
marker such as `[unintelligible]`.

### Playback is recorded, but it is still not approval

Each approve or disapprove decision stores the playback the person did for that
span before deciding:

- the fraction of the span's speech regions they played;
- the slowest and fastest playback rate they used.

Values are measured by the client and stored as reported; the group is small and
trusted. Playback never makes a span done. ADR 0006's rule that only explicit
decisions count is unchanged. It is recorded because an approval made without
listening is worthless for training, and that cannot be found out afterwards.
Correctors are told that playback coverage is recorded.

### Every revision records its origin and guide

A text revision stores:

- **its origin:** `machine` for the imported text, `manual` for an edit, or
  `suggestion` together with the backend key it was taken from, should
  suggestions from other backends be offered later;
- **the active guide revision** at the time it was written.

### The guide fixes the conventions before the first correction

**The corrector's text is the truth.** A corrector writes what is heard in the
span. The guide recommends, with examples, how to write it.

- **Fillers are not written.** This covers sounds such as "ehm", "hm" and "ééé".
  The model hardly writes them either: about 160 in 4.6 million words of the
  default transcript.
- **Cut words, restarts and repetitions are written as heard.** Example: "Šli
  jsme do pro- protože pršelo." or "Já jsem šel, já jsem jel do Prahy." Speakers
  do this all the time, and the transcript keeps it.
- **Numbers are written as digits.** Examples: "2 hodiny", "v roce 1989",
  "7. června", "v 8:30", "50 %", "3. kapitola".
  - "jeden", "jedna" and "jedno" stay words, as do fixed expressions such as
    "jednou" or "ani jeden".
  - The default transcript mixes the two today: about 3,700 numbers in digits
    against about 7,800 in words.
- **Foreign words keep their original spelling, with Czech endings.** Examples:
  "mindfulness", "na workshopu". Loanwords the Czech dictionary spells in Czech
  stay Czech, such as "víkend".
- **A word cut at a span boundary** belongs to the span where most of it is
  heard.
- **An empty span means that nothing was said.**

After the first correction the guide may gain clarifications and examples. Its
conventions may not change, because a change would make earlier corrections
inconsistent labels.

### Corrector consent is recorded before any writing

Before a person's first edit, flag or decision, they accept contributor terms.
The terms cover publishing their corrections and using them to train and
evaluate models. Acceptance is stored with the terms version and time. The
correction write commands refuse without it.

This version records nothing about the speakers on the recordings: no consent
and no speaker attribution.

### The contract is append-only

- **Schema changes to the correction tables are additive only.** Migrations
  must not rewrite or delete workspaces, spans, revisions, decisions, flags,
  consents, frozen sources or their fingerprints. A CI test fails on any
  migration that drops, renames or changes the type of their columns, or that
  updates or deletes their rows.
- **A nightly integrity check runs on production** and alerts by email on any
  mismatch. For every live workspace it verifies:
  - the source and staged-audio fingerprints;
  - span coverage of all VAD speech;
  - the 30 s span limit;
  - that no span crosses a chunk boundary;
  - every revision's text hash.
- **Backups:** the database keeps its existing daily dumps with NAS copies. The
  corrections tree and staged audio are already in the host snapshots.

### Training eligibility is export policy, not stored state

Which data trains a model is decided by export code at export time, so it can
change later without touching corrections. The initial policy is:

- **Training uses whole chunks.** A chunk qualifies when all of its spans are
  done and none has a flag. Its audio is the concatenation of its regions from
  the staged WAV. Its label is the spans' current texts joined in order.
- **Approvals must come from listening.** Every approval used must report
  playback of at least 90 % of the span's speech.
- **Test recordings are set aside first.** They are chosen before correction
  starts and are corrected whole, and none of their chunks ever trains a
  model.
- **Every export is recorded.** Its manifest lists the revision IDs used, so a
  training set can be rebuilt exactly.

When training samples across recordings, it samples whole chunks. A corrector
then receives the one to three consecutive spans of a chunk together.

### Launch gate

Production correction starts only after a dress rehearsal in the test
environment with the final UI:

1. Two people correct about an hour of audio, including flags and empty spans.
2. That work is exported, trained on and evaluated.
3. Every stored field is checked to hold what this record says.

From then on, the correction UI may change freely: layout, controls and
shortcuts. Export and training code may change. The data this record defines
may only be extended.

## Consequences

- Correctors hear all speech the model heard. Dropped speech appears as spans
  without text, and the reader gets it once corrected.
- Spans are more numerous than source segments (152,623 spans for 90,461
  chunks), but each is a contiguous piece of at most 30 s.
- Publication still emits one segment per span, with the span's start and end,
  `confidence: null` and `words: []`. Reader progress is still measured by
  duration.
- The existing production workspace, which has no human revisions, is archived
  and started again under this contract.
- A workspace can start only from a backend that records VAD regions. Switching
  `RAG_BACKEND_KEY` to one that does not would block new workspaces until it
  does.
- The schema gains workspace segmentation and audio identity, span chunk and
  region data, flag events, decision playback, revision origin and guide,
  and contributor consent.
- The UI can show VAD regions, machine words and speech without text, because
  that data is stored per span.

## Settled points

- Spans are runs of VAD regions inside one decoded chunk. They are split at
  silences of at least 1 s, and runs under 2 s are merged into a neighbour.
  They are never longer than 30 s and never cross a chunk boundary.
- The model input and its label can be rebuilt exactly from stored data.
- Workspaces refuse sources without VAD regions, and staged audio under a live
  workspace is protected.
- Flags describe the audio, never block publication, and exclude data from
  training. Unclear speech is flagged, not disapproved.
- Playback coverage is recorded with each decision and is never approval.
- Each revision records its origin and the active guide revision.
- The corrector's text is the truth. Fillers are not written; cut words and
  repetitions are written as heard; numbers use digits; foreign words keep their
  spelling. These conventions are fixed before the first correction, and only
  clarifications follow.
- Contributor consent is recorded before any write.
- This version records nothing about speakers.
- The correction data is append-only, checked in CI and every night.
- Training eligibility lives in export code.

## Deferred questions

- The exact wording of the contributor terms.
- How the UI presents the 1,981 spans that stay under 2 s because merging
  would pass 30 s, for example a quick "nothing said here" confirmation.
- Whether speaker consent or attribution is needed in a later version.
- Suggestions from other backends for spans without machine text.
- Forced alignment of corrected text for word-level reader highlighting.
