# Troubleshooting

> Common errors and debugging strategies for the Besedy pipeline.

## UnicodeDecodeError when loading JSON

**Symptom:** `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xe8 ...`

**Cause:** Some legacy whisper.cpp files were written with ISO-8859-1 (latin-1)
instead of UTF-8.

**Fix:** Always use `load_json_with_fallback()` instead of `json.load()`:

```python
# Wrong - fails on legacy files
data = json.loads(path.read_text(encoding="utf-8"))

# Correct - handles encoding automatically
from besedy.lib.data.encoding import load_json_with_fallback
data = load_json_with_fallback(path)
```

**Debug:** `file -i <path>/transcript.json` — if it shows `charset=iso-8859-1`,
use the fallback loader.

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
ls transcripts/faster-whisper/large-v3@silero_vad_v6@lang-auto/ | head -20
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
