# Fine-tuning Whisper on corrected transcripts

`training/` is a separate uv project for the GPU host (Linux, CUDA). It
fine-tunes `openai/whisper-large-v3` with LoRA on a dataset built from human
corrections under ADR 0012 and hands the result to the production backend.
Everything else in the loop runs from the main checkout.

The loop is **export → train → convert → eval → compare**. Every score comes
from one normalizer and one WER/CER implementation,
`besedy/lib/asr_evaluation.py`, so the numbers of the trainer, the production
evaluation and the machine-text baseline can be put in one table.

## 1. Export

```bash
just catalog training-export --catalog-id <catalog id>
```

Writes `<audio artifacts root>/training/training_export_<timestamp>/` (symlink
`training_export`): `audio/*.wav`, one per corrected chunk, and
`manifest.jsonl` with, per chunk, the corrected `text` (the label), the
`machine_text` the correctors started from (the production transcript of the
chunk), `split` (`train`, or `test` for the recordings listed in the catalog's
`test-recordings.json`), `audio_hash`, `revision_ids` and `revision_origins`.
`dataset.json` records the policy and the test list that was used.

Test recordings are chosen before correction starts and never train a model
(`docs/web/data-and-database.md`).

## 2. Train

```bash
cd training
uv sync
uv run train_whisper_lora.py --data <dataset dir> --out <run dir> [--epochs 2 --lr 1e-4 --lora-r 32]
```

The trainer reads the manifest and never uses the test split for tuning:

- A **dev set of whole recordings** is carved out of the train split by audio
  hash (`--dev-fraction 0.1`, `--seed`), deterministically. The dev hashes are
  written to `<run>/dev-recordings.json` and listed in `report.json`.
- **Before and after** training, `--eval-rows` dev chunks (80 by default, 0 for
  all) in seeded random order are scored with HF `generate` on whole chunks:
  loss, raw WER, normalized WER and normalized CER, next to the machine-text
  baseline on the same chunks. Every hypothesis goes to
  `dev_hypotheses_before.jsonl` and `dev_hypotheses_after.jsonl`, worst chunks
  first. Choose `--epochs`, `--lr` and `--lora-r` on these numbers.
- `--score-test` additionally scores the merged model on the whole test split
  with HF `generate` (`test_hypotheses.jsonl`). It is a quick look, not the
  production number: production decodes through faster-whisper with VAD and
  batching, which step 4 measures.

`<run>/merged` holds the merged checkpoint with large-v3's alignment heads
and a `preprocessor_config.json` (128 mel bins).

## 3. Convert

```bash
./backends/faster-whisper/convert_model.sh --model <run dir>/merged --output-dir ~/whisper_models/<name>-ct2
```

Runs `ct2-transformers-converter` in the faster-whisper image and checks the
mel bin count. The output directory is a CTranslate2 model faster-whisper
loads like `large-v3`.

## 4. Eval

```bash
just catalog training-eval --data <dataset dir> --model large-v3
just catalog training-eval --data <dataset dir> --model ~/whisper_models/<name>-ct2 --label finetuned
```

Scores a model on the dataset's **test** chunks through the production decode
path: the faster-whisper image, `BatchedInferencePipeline` and the options
`besedy/workflows/transcribe_faster_whisper.py` uses
(`besedy/lib/workflow/faster_whisper_options.py`). Each run writes
`<dataset>/eval/<label>_<timestamp>/report.json` (symlink
`<dataset>/eval/<label>`) with the model's identity (path, `model.bin` hash),
the decode options, faster-whisper and CTranslate2 versions, the dataset, the
git commit, a fingerprint of the scored rows and their references, the scores
and the machine-text baseline on the same rows, plus `hypotheses.jsonl`. A
chunk that fails to decode scores as an empty hypothesis and is listed under
`decode_errors` instead of aborting the run.

`--recordings <run dir>/dev-recordings.json --split train` scores the dev
recordings instead, and `--data <dataset>` without `--model` writes the
machine-text baseline alone, on the host, without Docker.

## 5. Compare

```bash
just catalog training-eval --compare <dataset>/eval/large-v3/report.json <dataset>/eval/finetuned/report.json
```

Prints one table: the machine text, production `large-v3` and the fine-tuned
model on identical chunks with identical normalization. Reports scored on
different rows are refused.

```
test split of /mnt/data/.../training_export_20261102_120000 (412 chunks, 2.1 h)
| system                                                  | rows | ref words | WER raw | WER norm | CER norm |
|---------------------------------------------------------|------|-----------|---------|----------|----------|
| machine text (production transcript, from the manifest) |  412 |     31204 | 21.37 % |  12.04 % |   4.81 % |
| large-v3                                                |  412 |     31204 | 21.90 % |  12.31 % |   4.95 % |
| finetuned                                               |  412 |     31204 | 17.42 % |   9.87 % |   3.90 % |
```

(Illustrative numbers.) The machine text and `large-v3` differ slightly even
with the same weights: the machine text was decoded from the whole recording,
the eval re-decodes each chunk's audio on its own.

## Normalization

`normalize_text` lowercases, turns every punctuation and symbol character into
a space, collapses whitespace and keeps diacritics and digits (NFC). It does
**not** convert numbers between digits and words: the correction guide writes
digits, so a model writing "dvě" for "2" makes a real error that a number
normalizer would hide. Hyphens count as punctuation, so a cut word "pro-"
scores like "pro" and a hyphenated compound splits in two. Raw WER is also
reported; it treats casing and punctuation as errors.

## Checks

```bash
uv run pytest tests/test_asr_evaluation.py tests/test_training_eval.py tests/test_faster_whisper_options.py
just ruff
just ty
```

The tests cover the normalizer, the metrics, the dev split, the row shuffle,
the reports and the `training-eval` command; none needs CUDA or Docker.
