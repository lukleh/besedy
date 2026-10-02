# Troubleshooting

> Common errors and debugging strategies for the Besedy pipeline.

## JSON file is not valid UTF-8

**Symptom:** `ValueError: <path> is not valid UTF-8 (byte offset N): ...`

**Cause:** The file was written in another encoding (for example ISO-8859-1)
or is not JSON at all (for example a macOS `._*` resource-fork file).
`load_json_with_fallback()` reads strict UTF-8 and refuses such files rather
than dropping the bytes it cannot decode.

**Fix:** Check the file with `file -i <path>`. Regenerate it, or convert it
once with `iconv -f <encoding> -t UTF-8` if you know its encoding. Delete
stray `._*` files.

## Backend 'xxx' not found

**Symptom:** `ValueError: Backend 'whisper' not found. Available backends: [...]`

**Cause:** Backend name doesn't match the canonical identifier (source of truth:
`besedy/lib/backend_ids.py`).

| Common mistake | Correct identifier |
|----------------|--------------------|
| `whisper` | `whisperx` |
| `nemo` | `canary-nemo` |
| `faster_whisper` | `faster-whisper` |

**Debug — list the backends actually present on disk:**

```python
from pathlib import Path
from besedy.core.paths import iter_transcript_paths, parse_transcript_components

root = Path("transcripts")
backends = {
    parse_transcript_components(path, root)[0]
    for path in iter_transcript_paths(root)
    if parse_transcript_components(path, root) is not None
}
print(sorted(backends))
```

## Hash lookup failures / FileNotFoundError

**Symptom:** `FileNotFoundError: transcripts/faster-whisper/<model>/abc123/transcript.json`

**Cause:** The hash prefix matches no existing transcript directory (wrong
prefix, or the hash hasn't been transcribed yet).

**Debug:**

```bash
# Find transcripts for a hash prefix
find transcripts/ -type d -name "abc123*"
# List hashes for a backend
ls transcripts/faster-whisper/large-v3@silero_vad_v6@lang-cs/ | head -20
# Check if hash is in a catalog
grep "abc123" audio_catalog_*.csv
```

## Schema validation errors

**Symptom:** `ValidationError: Missing required field 'meta.backend'` /
`Segment confidence 1.5 out of range [0, 1]`

**Cause:** Transcript JSON doesn't conform to the canonical schema (corrupt or
incomplete source, or a backend that failed mid-process).

**Debug — validate one file, then batch:**

```bash
# Single file
uv run python besedy/cli/catalog.py validate --input-path transcripts/faster-whisper/<model>/<hash>/transcript.json
# Directory (diarization checks on by default; add --no-diarization to skip)
uv run python besedy/cli/catalog.py validate --input-path transcripts/ --limit 50 -v
# Inspect JSON structure
jq 'keys' transcripts/<backend>/<model>/<hash>/transcript.json
jq '.meta | keys' transcripts/<backend>/<model>/<hash>/transcript.json
```

## No transcripts / empty results

**Symptom:** commands report "0 transcripts found", or a `segments` list comes
back empty.

**Possible causes:** audio not staged to WAV, wrong transcripts directory,
incomplete transcription, or an over-strict hash filter.

**Debug:**

```bash
ls staging/*.wav | wc -l                                   # staged audio present?
find transcripts/faster-whisper -name "transcript.json" | wc -l
find transcripts/canary-nemo   -name "transcript.json" | wc -l
find transcripts/whisperx      -name "transcript.json" | wc -l
find transcripts -name "transcript.json" | head -20        # what got discovered
```

## Models disagree / heavy ASR repetition

**Symptom:** transcripts from different models diverge heavily for the same
audio, or a model emits repetition loops.

**Cause:** poor audio quality, unusual speech, or ASR repetition — sometimes
only one model produced usable output for a time range.

**Debug:**

```bash
uv run python besedy/cli/analyze.py compare --hash <hash>      # segment timing across models
uv run python besedy/cli/analyze.py repetition --hash <hash>   # ASR repetition patterns
```

## Slow JSON loading / out of memory

**Cause:** repeatedly walking the whole `transcripts/` tree, or loading every
transcript into memory at once.

**Fix — stream via the shared discovery helpers, and filter early by hash/workflow:**

```python
from pathlib import Path
from besedy.core.paths import iter_transcript_paths
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.data.lookup import find_transcripts_for_hash, load_transcript_json

# Stream all transcripts
for path in iter_transcript_paths(Path("transcripts")):
    transcript = load_json_with_fallback(path)
    ...

# Or scope to a single hash/workflow up front
matches = find_transcripts_for_hash("abc123", Path("transcripts"), workflows=["faster-whisper"])
transcripts = [load_transcript_json(p) for p in matches.values()]
```

## Handy one-liners

```bash
# Check loudness of a staged file
ffmpeg -i staging/<hash>.wav -af "loudnorm=print_format=json" -f null - 2>&1 | grep input_i
# Count staged files
ls staging/*.wav 2>/dev/null | wc -l
```
