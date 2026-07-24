# Development Patterns

> **Last Updated:** 2026-04-04

Development guardrails for the Besedy codebase. Follow these patterns when
adding or changing code.

---

## Error Patterns

### Graceful Degradation

Return `None` instead of raising for expected failures (missing tools, invalid
input, optional features). Let callers decide how to handle missing data.

`return None  # tool unavailable, not an error`

Anti-pattern: raising `FileNotFoundError` or custom exceptions on expected
failures. Never create custom exception classes. Use built-in types
(`ValueError`, `RuntimeError`, `FileNotFoundError`) with descriptive messages.

### Result Tuple

Return `(value, error_message)` when callers need the failure reason for user
feedback. On success: `(result, None)`. On failure: `(None, "description")`.

`duration, error = probe_media_duration_seconds(path, ffprobe=ffprobe)`

### Batch Continuation

Return `(successes, failures)` lists. Never stop batch processing on first
failure. Collect all results, report at the end.

Anti-pattern:
```python
for item in items:
    process(item)  # raises on failure, stops everything
```

Do instead:
```python
successes, failures = [], []
for item in items:
    try:
        successes.append(process(item))
    except Exception as exc:
        failures.append((item, exc))
```

### Validation Returns Issue List

Return `list[str]` of problems. Empty list means success. Never raise on
validation failures.

`issues = validate_meta(meta)  # [] means valid`

### Encoding Fallback

Always use `load_json_with_fallback()` from `besedy.lib.data.encoding`, never
bare `json.load()` or `json.loads(path.read_text())`. Legacy files may have
latin-1 encoding. The fallback loader tries UTF-8 first, then recovers
latin-1-encoded UTF-8 bytes, and converts parse errors to `ValueError`.

Anti-pattern: `data = json.loads(path.read_text(encoding="utf-8"))`

Do instead: `data = load_json_with_fallback(path)`

### Required vs Optional

Use `RuntimeError` for configuration/setup failures that must be fixed (missing
required tools). Return `None` for optional features (missing optional tools).

### Exception Type Reference

| Situation | Type |
|-----------|------|
| Invalid argument value | `ValueError` |
| Missing required file | `FileNotFoundError` |
| Missing required config/tool | `RuntimeError` |
| Invalid JSON structure | `ValueError` |

---

## CLI Output

### Timestamped Directory Pattern

All CLI commands that produce output directories use `{base_name}_{timestamp}/`
where timestamp is `YYYYMMDD_HHMMSS`. (Historical `transcripts_{timestamp}_{variant}/`
directories from the removed enhanced pipeline remain readable but are no
longer produced.)

### Symlink Convention

Create a symlink `{base_name}/` pointing to the latest timestamped directory.
Symlinks always use **relative paths** (via `os.path.relpath()`). Update by
unlinking then creating. Validate the symlink can be created before starting
work.

### Timestamp Derivation

Extract timestamp from the **upstream artifact** (input directory or CSV
filename), not from the current wall clock. This ensures all artifacts from a
single processing run share the same timestamp.

| Command | Timestamp Source |
|---------|------------------|
| transcribe | Normalized catalog CSV filename |
| convert | `transcripts_{timestamp}/` directory name |
| export-transcripts | `transcripts_{timestamp}/` directory name (writes in-place) |

### JSON Envelope

Commands supporting `--format json` write one JSON object to stdout:
`{"name": "<command>", "status": "success|warning|error", "result": {...}}`

### New CLI Command Checklist

1. Extract timestamp from upstream artifact.
2. Use `{base_name}_{timestamp}/` naming.
3. Validate symlink before starting work.
4. Create timestamped output directory.
5. Create/update symlink to latest.
6. Use helpers from `besedy/core/paths.py` and
   `besedy/commands/catalog/symlink.py`. Do not hand-roll output naming.

---

## Feature Checklist

### Pre-Flight

Before writing code, determine:

- **Layer ownership.** CLI parsing: `besedy/cli/`. Command logic:
  `besedy/commands/`. Library code: `besedy/lib/`. Workflow orchestration:
  `besedy/lib/workflow/` or `besedy/workflows/`. Web routes: `web/src/app/`.
- **Source-of-truth files.** Backend IDs: `besedy/lib/backend_ids.py`. Workflow
  registration: `besedy/lib/workflow/config.py` and `runner.py`. Output schemas:
  `docs/schemas/transcript.schema.json`. Permissions:
  `docs/web/security.md`. API surface: `docs/web/architecture.md`.

### CLI/Pipeline Changes

Keep argument parsing in `besedy/cli/*.py`, business logic in
`besedy/commands/*`. Return integer exit codes. Use Rich for user-facing output.
Add parser coverage in `tests/test_cli_parser.py`.

### Workflow/Backend Changes

1. Add/update the canonical backend ID in `besedy/lib/backend_ids.py`.
2. Register in `besedy/lib/workflow/config.py` and `runner.py`.
3. Keep `transcript.json` compatible with the schema.
4. Use `besedy/lib/runtime/backend_runtime.py` for heavyweight backends.
5. Ensure `meta.backend` uses the canonical ID.

### Library Changes

Choose the existing domain module first (`audio`, `workflow`, `validation`,
`data`, `analysis`, `speakers`). Keep config access lazy so imports do not
require `besedy.toml`. Prefer small typed functions and structured return values
over dict blobs.

### Documentation Rule

When code changes: update the existing canonical reference doc, or archive the
old plan/spec if it becomes historical. Never create parallel docs that restate
the same behavior in different words.

---

## Testing

### Pytest Markers

| Marker | When to Use |
|--------|-------------|
| `@pytest.mark.integration` | Requires external tools (ffmpeg, etc.) |
| `@pytest.mark.gpu` | Requires CUDA GPU |
| `@pytest.mark.slow` | Takes > 30 seconds |
| `@pytest.mark.e2e` | End-to-end pipeline tests |

Run fast tests only: `uv run pytest -m "not slow and not integration"`

### Test File Conventions

- Files: `test_<module>.py` or `test_<backend>_<purpose>.py`
- Functions: `test_<what>_<expected_behavior>`
- Group related tests in classes
- Fixtures in `tests/conftest.py`

### Fixture Generation

Tool-availability fixtures are session-scoped. Use `require_ffmpeg` pattern to
skip gracefully. Audio fixtures: `create_silent_wav()` from
`tests/helpers/audio`. Transcript fixtures: `sample_transcript()` in conftest.

Web E2E fixtures are auto-generated in `web/tests/e2e/fixtures/` (gitignored)
by scripts in `web/tests/e2e/scripts/generate-*.ts`.

### E2E Auth Helpers

E2E tests create signed sessions directly against the test database and set the
session cookie in Playwright. No mock-auth UI.

`await loginAs(page, "editor")  // uses helpers/auth.ts`

Seeded test users: see `web/prisma/test-data.ts` and
`web/tests/e2e/helpers/auth.ts`. Roles: superadmin, admin, owner, editor,
member, viewer, listener, noaccess, pending, blocked.

### Assertion Patterns

- Graceful degradation: `assert result is None`
- Validation: `assert issues == []` for pass, check `len(issues)` for fail
- Batch: `successes, failures = process_batch(items)`
- Exceptions: `with pytest.raises(ValueError, match="format")`

---

## Common Pitfalls

### Encoding: Never Use Bare json.load

Always `load_json_with_fallback(path)`. Legacy files will cause
`UnicodeDecodeError` with bare `json.loads(path.read_text())`. This is the
single most common pipeline error.

### Backend Identifiers: Use Canonical IDs

Never hardcode backend name strings. Import from `besedy/lib/backend_ids.py`.

| Wrong | Correct |
|-------|---------|
| `"whisper"` | `"whisperx"` |
| `"nemo"` | `"canary-nemo"` |
| `"faster_whisper"` | `"faster-whisper"` |

### Symlinks: Always Relative

Never create absolute symlinks. Use `os.path.relpath()`. Absolute symlinks
break when data directories are mounted or moved.

### Config Access: Keep It Lazy

`besedy/config/settings.py` lazily loads config on first access. Do not force
config loading at import time. For tests use `set_config()` / `reset_config()`.

### Validation: Return Issues, Don't Raise

Validators return `list[str]`. An empty list means success. Never raise
exceptions from validation logic. Callers decide whether to abort or continue.

### Batch Processing: Never Abort on First Failure

Collect `(successes, failures)`. Report counts and error details at the end.
Pipeline commands must be resilient to partial failures.

### Timestamps: Derive, Don't Generate

Extract the timestamp from the upstream artifact. Never generate a new timestamp
for a downstream output. All artifacts from one processing run share the same
timestamp.
