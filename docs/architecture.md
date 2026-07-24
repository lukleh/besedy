# Architecture & Design Decisions

> **Last Updated:** 2026-07-15

Durable cross-system rationale is indexed in
[Architecture Decision Records](adr/README.md). This page remains the canonical
overview of the current component and pipeline structure.

## Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                      BESEDY PIPELINE FLOW                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Audio Files (MP3/WAV/FLAC/etc.)                                   │
│       │                                                             │
│       ▼                                                             │
│  ┌────────────────┐                                                 │
│  │ just catalog   │  Computes typed decoded-audio SHA-256 hashes  │
│  │  add / create  │  Updates: audio_catalog_<timestamp>.csv        │
│  └───────┬────────┘                                                 │
│          │                                                          │
│          ▼                                                          │
│  ┌────────────────┐                                                 │
│  │  run-pipeline  │  Orchestrates loudness, staging, ASR, and      │
│  │ (stage-audio)  │  downstream artifacts for pending recordings   │
│  └───────┬────────┘                                                 │
│          │                                                          │
│          ├────────────────┬────────────────┬───────────────────┐   │
│          ▼                ▼                ▼                   │   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │   │
│  │  Canary     │  │  Faster     │  │ WhisperX /  │             │   │
│  │  NeMo       │  │  Whisper    │  │ Qwen3-ASR   │             │   │
│  │ (lang: cs)  │  │ (lang:auto) │  │ (lang:auto) │             │   │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │   │
│         │                │                │                     │   │
│         └────────────────┼────────────────┘                     │   │
│                          ▼                                      │   │
│              transcripts_<timestamp>/                           │   │
│              ├── canary-nemo/{component}/{hash}/transcript.json │  │
│              ├── faster-whisper/{component}/{hash}/transcript.json││
│              ├── whisperx/{component}/{hash}/transcript.json    │  │
│              └── qwen3-asr/{component}/{hash}/transcript.json   │  │
│                          │                                      │   │
│                          ▼                                      │   │
│                    ┌─────────────┐                              │   │
│                    │  Pyannote   │                              │   │
│                    │  Diarize    │                              │   │
│                    └──────┬──────┘                              │   │
│                           │                                     │   │
│                           ▼                                     │   │
│                    speaker_diarization/                         │   │
│                    └── pyannote/                               │   │
│                        └── {hash}/speakers.json                │   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MODULE ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  CLI Layer (thin)           Commands Layer         Library Layer    │
│  Argument parsing only      Business logic         Reusable core    │
│  ─────────────────────      ──────────────         ──────────────   │
│                                                                     │
│  cli/catalog.py      ───▶  commands/catalog/  ───▶ lib/catalog/    │
│    create, stage            handle_create()        manager.py       │
│    transcribe               handle_stage()         validator.py     │
│    diarize                  handle_transcribe()                     │
│                                                                     │
│  cli/analyze.py      ───▶  commands/analyze/  ───▶ lib/analysis/   │
│    stats, compare           handle_stats()         alignment.py     │
│    speakers, insight        handle_compare()       repetition.py    │
│                                                                     │
│  cli/catalog.py      ───▶  commands/catalog/  ───▶ lib/validation/ │
│    validate                handle_validate()      core.py          │
│                                                    schema.py        │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Workflow Layer (Backend Runners)                                   │
│  ────────────────────────────────                                   │
│                                                                     │
│  workflows/transcribe_nemo.py         NeMo Canary transcription    │
│  workflows/transcribe_faster_whisper.py  Faster-Whisper pipeline   │
│  workflows/transcribe_whisperx.py     WhisperX (alignment + VAD)   │
│  workflows/transcribe_qwen3_asr.py    Qwen3-ASR + external Silero  │
│  workflows/diarize_pyannote.py        Pyannote speaker diarization │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│  Core Utilities                                                     │
│  ──────────────                                                     │
│                                                                     │
│  core/paths.py              Path constants, audio-hash utilities   │
│  lib/data/encoding.py       JSON loading with encoding fallback    │
│  lib/data/lookup.py         Transcript file discovery              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Conventions

Output directories use timestamped naming with symlinks for `latest`:

```
audio_catalog_20251129_153045.csv
audio_catalog_20251129_153045_normalized.csv
transcripts_20251129_160000/

transcripts/ ──────▶ transcripts_20251129_160000/   (symlink)

transcripts/
└── faster-whisper/
    └── large-v3@silero_vad_v6/
        └── 0f2fa31aad030970…cc91/ ◀── full 64-character audio hash
            └── transcript.json
```

---

## Design Decisions

### 1. Content-Addressed Storage (SHA-256)

Every recording is identified by SHA-256 over decoded 16 kHz mono signed
16-bit PCM (`pcm-s16le-16000hz-mono-sha256-v1`) -- the primary key across all
systems. New catalogs persist the algorithm in `Hash Algorithm`, and typed
`.audiohash` sidecars carry the same contract.

**Rationale:** Identity is independent of filename, path, and container
metadata. The same decoded audio in different locations deduplicates
automatically. All artifacts (transcripts, diarization, staged audio) correlate
by hash. Changing container-only metadata does
not change the audio hash. Recomputing the hash verifies the identity contract.

**Failure policy:** If ffmpeg cannot decode a source, catalog creation/addition
reports the file as an error and does not emit a row or `.audiohash`. It never
substitutes a different identity algorithm.

**Compatibility:** Catalogs without `Hash Algorithm` cannot be extended or
merged and must be recreated from source audio. Untyped `.audiohash` sidecars
are recomputed rather than trusted.

**Trade-offs:** Decoding and hashing large files adds cataloging time. A decoder
or resampling-contract change requires a new algorithm version and an explicit
transition plan. Undecodable sources must be repaired or handled outside the normal
catalog pipeline.

### 2. Two-Stage Pipeline (Stage then Process)

Audio normalization (staging) is a separate step from transcription/diarization.

**Rationale:** Stage once to 16kHz mono WAV, then run multiple backends or parameter sweeps without re-normalizing. All workflow runners assume standardized input, simplifying implementation. Staged audio is a visible, debuggable checkpoint. Compliant source files can be symlinked to avoid copies.

**Trade-offs:** Requires disk space for staged audio. Extra pipeline step vs. direct processing.

### 3. EBU R128 Loudness Normalization

Staged audio is normalized to -16 LUFS (EBU R128), acceptable range -20 to -12 LUFS.

**Rationale:** ASR models perform better with consistent loudness. EBU R128 is the broadcast standard with broad tool support. -16 LUFS provides headroom while staying clear for speech. Files outside the tolerance range get aggressive normalization with dynamic compression.

**Trade-offs:** Compression may affect audio quality at range boundaries. Loudness measurement adds processing time.

### 4. Timestamp-Aligned Artifacts

All related artifacts share a timestamp: `audio_catalog_<TS>.csv`, `audio_catalog_<TS>_normalized.csv`, `transcripts_<TS>/`.

**Rationale:** Easy to correlate which catalog produced which transcripts. Multiple pipeline runs coexist without confusion. `assert_catalog_transcripts_alignment()` enforces matching.

**Trade-offs:** Longer, less human-friendly directory names. Requires tooling to work with timestamped paths.

### 5. Polars with Nested Schemas

Polars DataFrames with nested `List[Struct]` columns for words within segments, cached as Parquet.

**Rationale:** 12x speedup over JSON iteration for batch analysis. Arrow memory format enables lazy evaluation and columnar ops. Nested structure preserves segment-word hierarchy without denormalization. Parquet cache makes subsequent loads instant. Can work at segment level or explode to flat words table.

**Trade-offs:** Polars learning curve (explode, unnest). Cache files add disk usage. Overkill for small datasets.

### 6. Canonical Transcript Schema

All transcription backends output the same JSON schema: `segments[]` with `start`, `end`, `text`, `confidence`, and nested `words[]`.

**Rationale:** Analysis tools are backend-agnostic -- no conditional logic per backend. Direct cross-backend comparison. Single schema validator covers all backends. New backends only implement the conversion once.

**Trade-offs:** Backend-specific features (language detection, embedded speaker IDs) may be lost in conversion. Requires maintaining a converter per backend.

### 7. Full Audio-Hash Directories

Transcripts are stored as
`<workflow>/<output-component>/<audio_hash>/transcript.json`, where
`audio_hash` is the full 64-character SHA-256 value. The output
component includes a language suffix for auto-detected and explicitly
non-Czech variants; explicit Czech retains the legacy suffix-free path.

**Rationale:** The backend and model-component levels partition the artifact
tree, while the full hash provides deterministic, collision-resistant lookup
without a second disambiguation mechanism. Short prefixes remain accepted by
operator search commands, but are not the persisted directory identity.

**Trade-offs:** Paths are long and not pleasant to type manually; CLI output
may abbreviate hashes for display.

### 8. Speaker ID Scope

Speaker identifiers (`SPEAKER_01`, etc.) are unique only within a single audio file.

**Rationale:** Diarization models can only distinguish speakers within one recording. No false cross-file connections. Simpler implementation -- no global speaker registry needed. Cross-file clustering can be added as a post-processing step.

**Trade-offs:** Same speaker across recordings gets different IDs. Cross-file analysis requires an explicit clustering step.

### 9. Opus Archive Compression

Audio archiving uses Opus codec, `voip` application mode, 32 kbps default (`low` quality preset).

**Why 32 kbps:** IETF MUSHRA tests scored Opus fullband at 32 kbps as 98.13/100 -- "almost transparent." RFC 6716 and Xiph guidance place fullband speech at 28-40 kbps. Diminishing returns beyond 32 kbps for speech-only content.

**Why `voip` mode:** Applies high-pass filter and formant emphasis to improve intelligibility in noisy environments -- matches the noisy discussion panel recordings in this corpus.

**Quality presets:**

| Preset | Bitrate | Use case |
|--------|---------|----------|
| low (default) | 32 kbps | Speech archival -- "almost transparent" |
| medium | 48 kbps | Mixed speech/music, safety margin |
| high | 64 kbps | Significant musical content |
| max | 96 kbps | Rarely justified for speech |

**Additional settings:** 24 kHz sample rate (super-wideband, sufficient for speech), VBR enabled, compression level 10, mono.

**Trade-offs:** Minor artifacts in direct A/B at 32 kbps. VoIP high-pass removes sub-80 Hz content. Music-heavy content benefits from `--quality medium` (48 kbps).
