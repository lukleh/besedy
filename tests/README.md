# Tests

The test suite covers the Python pipeline, workflow orchestration, transcript
validation, web integration helpers, and a legacy whisper.cpp conversion path.

## Quick Start

```bash
# Run the full Python suite
uv run pytest

# Run a focused parser test
uv run pytest tests/test_cli_parser.py::TestCatalogParserStructure::test_subcommand_names -v

# Skip slower or environment-heavy cases
uv run pytest -m "not slow and not integration and not gpu"
```

## Suite Layout

- `test_cli_*` and `test_analyze_cli.py`: parser, dispatch, and JSON output checks
- `test_audio_*`, `test_catalog_*`, `test_pipeline*.py`: core pipeline and catalog behavior
- `test_workflow_*`, `test_gpu_workflows.py`, `test_real_*`: workflow runners and environment-specific coverage
- `test_validation_schema.py`, `test_alignment.py`, `test_repetition.py`, `test_subtitles.py`: transcript analysis and validation logic
- `test_rag_*`, `test_speaker_*`: retrieval and speaker-matching coverage
- `test_whisper_cpp_*`: legacy whisper.cpp conversion and UTF-8 edge cases

## Markers

Markers live in `pytest.ini`:

- `integration`: needs external tools such as `ffmpeg`
- `gpu`: needs CUDA
- `slow`: long-running scenarios
- `e2e`: end-to-end pipeline coverage

Examples:

```bash
uv run pytest -m "not slow" -q
uv run pytest -m integration tests/test_real_audio_processing.py -v
uv run pytest -m gpu tests/test_workflow_transcribe_nemo.py -v
```

## Web-Related Tests

- Unit tests: run `npm run test` from `web/`
- E2E tests: run `npm run test:e2e` from `web/`
- Seeded auth users live in `web/prisma/test-data.ts`
- Playwright auth helpers live in `web/tests/e2e/helpers/auth.ts`

## Adding Tests

- Put reusable fixtures in `tests/conftest.py` or `tests/helpers/`
- Prefer small unit tests first; add markers only when a test truly needs extra tooling
- If you change docs or shared schemas, add or update a drift-prevention test alongside the code change
