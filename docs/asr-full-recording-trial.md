# Optional ASR candidates: full-recording trial

On 8 November 2026, both optional candidates ran through `catalog transcribe`
on the same complete Czech recording: **1,473.213 seconds (24 minutes 33 seconds)**
of staged 16 kHz mono audio. The inputs were original pretrained checkpoints,
rather than weights adapted in the earlier training smoke experiments.

Hardware: NVIDIA GeForce RTX 5070 Ti, 16,303 MiB. The two jobs ran sequentially
through the existing process-worker pool. The temporary experiment deployment
was removed after both completed. No default workflow, correction source, or
search transcript was changed.

## Results

| Candidate | Pipeline | Wall time | Sampled device-memory peak | Segments | Words |
|---|---|---:|---:|---:|---:|
| CzechSpeech | Existing WhisperX worker, CTranslate2 model, Czech forced alignment | 41.22 seconds | 4,239 MiB | 241 | 3,081 |
| Nemotron Labs Unified 0.6B | New optional `nemo-rnnt` worker, Silero VAD, native word timestamps | 58.09 seconds | 3,029 MiB | 167 | 3,007 |

Times include pipeline startup, transcription and alignment where configured;
models and dependencies were downloaded beforehand. Memory figures are sampled
whole-device usage, rather than exact allocator peaks. These measurements
describe one recording and are not a general throughput benchmark.

Both runs:

- Finished successfully through the catalog command and Docker runtime.
- Preserved the full input duration in metadata and produced substantial text
  through the end of the recording.
- Passed the canonical transcript validator and the catalog CLI schema checks.
- Produced JSON and TXT/SRT/VTT exports with ordered, bounded recording-time
  timestamps. CzechSpeech sidecars used the existing `export-transcripts` step.

There is no corrected reference for this trial. Word counts, schema checks and
successful decoding do not establish which model transcribes more accurately.
Fine-grained timing was not manually audited against the audio.

## Timing and format details

RNNT timestamps are already seconds when NeMo returns them. The worker adds
each VAD region's recording offset once. Native frame resolution is 80 ms for
this checkpoint. Multiple words can be emitted in the same frame; the worker
normalizes overlap only within that frame and rejects larger inconsistencies.
Twenty of the 3,007 resulting words have zero-duration timing at that resolution,
versus zero in the forced-aligned CzechSpeech output. This is a limitation for
fine-grained word highlighting, even though the canonical contract permits it.

Unavailable RNNT confidence remains `null`. A legacy CLI validator disagreed
with the existing canonical nullable-confidence contract; it now accepts null
while continuing to reject nonnumeric values such as booleans and strings.

The RNNT worker honors the existing configured VAD silence duration when set,
with a 500 ms fallback. It uses a separate NeMo 3.1 image so Canary retains its
existing runtime. The pipeline flags for both candidates are
`pipeline_default = false` and `expected_default = false`.

## Revisions

| Artifact | Revision |
|---|---|
| Unified checkpoint | `023ce907267a09a308a5cb69239447cb3d0c1597` |
| CzechSpeech checkpoint | `0762c5de1e8a2438f8e70f07c0d56beb27684ede` |
| NeMo Speech source | `cd61689d41b1962d3e1957ae8faf28bf8bee0e3b` |
| RNNT Docker image used | `sha256:167ae40fa6005a80c74936e383a7bdbd7106c4754b5847ffa9b833ab022b9cfa` |
| Existing WhisperX Docker image used | `sha256:e2d4d2aeb0c42465e72f72bcc4f819f799c1163e66ae7ea11d6741577086d760` |

See [backend setup](backends.md#optional-asr-candidates) for configuration and
run commands, and the [model landscape](asr-model-landscape.md) for the wider
downloadable-model assessment. Local model directory names must be unique, such
as `czechspeech-ct2`, because they form part of transcript identities.

## Verification

- Full Linux suite: **2,336 passed, 17 skipped**; CUDA was hidden for the unit
  suite. The two real Docker/GPU trials above cover inference separately.
- Ruff, repository type checks, Python 3.11 syntax checks, and all nine Compose
  renders passed.
- The full macOS suite had 2,295 passes, 50 skips and eight existing audio-hash
  fixture failures with Homebrew FFmpeg 9.0.2. The same fixture tests pass on the
  Linux host's known-good decoder build. No golden hashes or hash checks were
  changed.

The full all-extras type environment also exposes an unchanged Whisper trainer
typing issue in the Transformers `.to()` decorator. Repository type checks pass
with the exact lean environment used by CI. The new RNNT worker separately
passed its type checks with the additional NeMo/OmegaConf types installed.
