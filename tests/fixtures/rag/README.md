# RAG Eval Fixtures

These committed files are synthetic, version-stable Czech-language examples of
the ColBERT RAG evaluation schema. Their questions and deterministic placeholder
hashes are not derived from a private corpus and are not expected to match a real
index.

Placeholder hashes are reproducible: they are SHA-256 digests of
`besedy-public-fixture-NN`, numbered sequentially across the four files.

Rules:

- only synthetic audio-target examples are committed
- corpus-linked questions and hashes belong in `tests/fixtures/rag/local/`, which
  is gitignored
- chunk-target fixtures are regenerated after chunk-layout changes
- `tests/rag_colbert_eval.py` validates chunk-target records against the active bundle manifest

Current fixtures:

- `questions_20_audio.json`
  - a 20-question synthetic example set suitable for parser and workflow checks
- `czech_stress_audio.json`
  - a synthetic Czech-oriented stress subset focused on:
    - diacritics mismatch
    - shorthand / informal spelling
    - morphology / inflection mismatch
- `questions_benchmark_audio.json`
  - a 25-question synthetic benchmark preserving the keyword, semantic,
    diacritics, metaphor, and multi-concept category mix
- `oblique_queries.example.json`
  - three synthetic examples of time-grounded oblique-query records
  - use them to understand the schema, not to score a real index

For oblique search tests, prefer chunk IDs or `audio_hash` + time spans. Audio-only
targets can hide failures where the retriever found the right recording but not
the right evidence window. See `docs/rag-oblique-eval.md`.

For a meaningful retrieval benchmark, create a private fixture that targets the
active corpus, for example `tests/fixtures/rag/local/questions_audio.json`. Never
commit that file. Typical local workflow:

```bash
uv run python tests/rag_colbert_eval.py \
  --questions tests/fixtures/rag/local/questions_audio.json \
  --index-dir /path/to/private/colbert/index \
  --k 10 \
  --json
```

Oblique workflow:

```bash
uv run python tests/rag_colbert_eval.py \
  --questions tests/fixtures/rag/local/oblique_queries.json \
  --index-dir /path/to/private/colbert/index \
  --cutoffs 10 50 100 200 \
  --details-path tmp/rag_eval/oblique_colbert.json \
  --include-hit-details
```
