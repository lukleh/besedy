# Oblique RAG Evaluation

Oblique queries ask for latent evidence rather than words that appear directly in
the transcript. They are useful for testing Besedy search behavior that normal
keyword-style fixtures do not cover.

The initial goal is diagnostic: measure whether ColBERT surfaces the right
evidence before changing production retrieval.

## Fixture Shape

Both `tests/rag_colbert_eval.py` and the legacy `tests/rag_eval.py` accept the
same eval record list with either `question` or `query`:

```json
[
  {
    "id": "oblique_implicit_acceptance_001",
    "query": "najdi misto, kde recnik rozlisuje prijeti situace od souhlasu s nasilim",
    "category": "implicit_theme",
    "targets": [
      {
        "audio_hash": "<sha256>",
        "start_seconds": 1234.5,
        "end_seconds": 1290.0
      }
    ],
    "rationale": "The passage distinguishes acceptance from approval."
  }
]
```

Prefer chunk or time-grounded targets. Audio-only targets are still accepted, but
they are too coarse for oblique retrieval: finding the right recording does not
mean finding the right moment.

Supported target forms:

- `{"chunk_id": "..."}`
- `{"audio_hash": "..."}`
- `{"audio_hash": "...", "start_seconds": 10.0, "end_seconds": 25.0}`
- `start`/`end` and `start_sec`/`end_sec` are accepted aliases for generated fixtures.

Audio hashes must be 64-character SHA-256 hex values, and time spans must start
at or after zero. The evaluation commands reject malformed records instead of
silently excluding them from the denominator.

## Metrics

`tests/rag_colbert_eval.py` now reports:

- strict recall at each cutoff, where the returned chunk must match `chunk_id` or
  overlap the target time span
- audio recall at each cutoff, which only checks whether any chunk from the right
  recording was retrieved and only includes records with an `audio_hash` target
- MRR at each cutoff
- cutoff-specific `audio_only_misses`, where ColBERT found the right recording
  but not the target evidence window

This separates three cases:

- retrieval works: the target window appears in the candidate pool
- retrieval is too broad: the right audio appears, but the target window does not
- retrieval fails: neither the target window nor the target audio appears

## Workflow

Create a real fixture from transcript review under the gitignored
`tests/fixtures/rag/local/` directory. Corpus-linked questions, hashes, and
timestamps must not be committed. Then run:

```bash
uv run python tests/rag_colbert_eval.py \
  --questions tests/fixtures/rag/local/oblique_queries.json \
  --index-dir /path/to/private/colbert/index \
  --cutoffs 10 50 100 200 \
  --details-path tmp/rag_eval/oblique_colbert.json \
  --include-hit-details
```

Use the `details_path` artifact to inspect missed candidates and establish
whether a downstream answer failure starts in retrieval. Answer synthesis must
be evaluated separately.

All requested cutoffs are measured from one query at the largest cutoff. This is
prefix-neutral on the default fast PLAID backend. The Stanford PLAID backend
changes its probe width with `k`, so a lower cutoff from a multi-cutoff run may
not be directly comparable to a standalone `--k` run.

## Next Experiments

If strict recall is low but audio recall is high, inspect chunking and context
windows first. If both are low, test deep-search query expansion before changing
the ColBERT model. If query expansion still misses targets, index auxiliary
per-chunk "lens" text such as summaries, claims, metaphors, speakers, and themes.
