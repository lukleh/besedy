# lib/ Module Guide

`besedy/lib/` holds the reusable implementation layer behind the CLI.
Keep argument parsing in `besedy/cli/` and `besedy/commands/`; use
`besedy.lib.*` for logic you want to share across commands, scripts, and tests.

## Quick Map

| Task | Module | Key entry points |
|------|--------|------------------|
| Load transcript JSON with encoding fallback | `data/encoding.py` | `load_json_with_fallback()` |
| Find transcript files for a hash | `data/lookup.py` | `load_transcript_json()`, `find_transcripts_for_hash()` |
| Validate canonical transcript schema | `validation/schema.py` | `validate_canonical_schema()` |
| Run shared transcript or diarization validation | `validation/core.py` | `validate_single_file()`, `validate_diarization_file()` |
| Build and merge catalog CSV data | `catalog/manager.py` | `collect_input_files()`, `build_record_for_file()`, `merge_catalogs()` |
| Validate catalog integrity | `catalog/validator.py` | `validate_catalog()` |
| Stage normalized 16kHz mono WAV audio | `audio/normalize.py` | `stage_audio_files()` |
| Inspect loudness and technical audio quality | `audio/quality.py` | `analyze_loudness()`, `analyze_audio_file()` |
| Iterate normalized catalog rows for workflows | `workflow/common.py` | `iter_audio_csv_rows()`, `CsvAudioRow` |
| Build and launch workflow commands | `workflow/runner.py` | `build_workflows()`, `launch_workflows()` |
| Compare transcript intervals across backends | `analysis/comparison.py` | `compare_transcripts()` |
| Detect repeated transcript text | `analysis/repetition.py` | `detect_all_repetitions()` |
| Align words across transcripts | `analysis/alignment.py` | `analyse_word_overlap()` |
| Build subtitle sidecars | `analysis/subtitles.py` | `render_srt()`, `render_vtt()` |
| Extract timeline summaries | `analysis/timeline.py` | `extract_segments()`, `summarize_intervals()` |
| Build and query the local RAG index | `rag_retrieval.py` | `ingest_phase1_index()`, `query_phase1_index()` |
| Cluster or match speakers across files | `speakers/` | `cache.py`, `embeddings.py`, `matching.py`, `utils.py` |

## Import Conventions

Use fully qualified imports from `besedy.lib`, not the old `lib.*` shortcut.

```python
from besedy.lib.data.encoding import load_json_with_fallback
from besedy.lib.data.lookup import find_transcripts_for_hash
from besedy.lib.validation.schema import validate_canonical_schema
from besedy.lib.workflow.common import CsvAudioRow, iter_audio_csv_rows
```

## Common Patterns

### Load one transcript safely

```python
from pathlib import Path

from besedy.lib.data.lookup import load_transcript_json

transcript = load_transcript_json(Path("transcript.json"))
if transcript is None:
    raise RuntimeError("transcript could not be loaded")
```

### Validate a canonical transcript payload

```python
from besedy.lib.validation.schema import validate_canonical_schema

issues = validate_canonical_schema(transcript)
if issues:
    for issue in issues:
        print(issue)
```

### Iterate catalog rows for workflow execution

```python
from besedy.lib.workflow.common import iter_audio_csv_rows

for row in iter_audio_csv_rows(csv_path, require_duration=True):
    print(row.sha256, row.full_path)
```

## Related References

- `docs/architecture.md`
- `docs/data-model.md`
- `docs/patterns.md`
