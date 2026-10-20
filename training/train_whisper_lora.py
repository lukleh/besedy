"""LoRA fine-tune of Whisper large-v3 on a dataset from `catalog training-export`.

The dataset holds one WAV per corrected chunk, exactly the audio the model
was given, and manifest.jsonl with its corrected text and its split
(ADR 0012). About half the labels carry a start and end timestamp token so
the model keeps its timestamp mode; the rest are text only, the mode the
batched production decoding uses.

The merged checkpoint in <out>/merged is ready for
backends/faster-whisper/convert_model.sh: it keeps large-v3's alignment
heads and writes preprocessor_config.json (128 mel bins).

    cd training && uv run train_whisper_lora.py --data <dataset dir> --out <run dir>
"""

import argparse
import json
import math
import random
import time
from pathlib import Path

import jiwer
import soundfile as sf
import torch
from peft import LoraConfig, get_peft_model
from transformers import WhisperForConditionalGeneration, WhisperProcessor

BASE = "openai/whisper-large-v3"


def load_rows(data_dir, split):
    rows = []
    with open(Path(data_dir) / "manifest.jsonl", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            if row["split"] == split:
                rows.append(row)
    return rows


def encode_labels(tokenizer, text, duration, with_timestamps):
    tokenizer.set_prefix_tokens(
        language="czech", task="transcribe", predict_timestamps=with_timestamps
    )
    if with_timestamps:
        end = min(30.0, round(duration / 0.02) * 0.02)
        ids = tokenizer(f"<|0.00|> {text}<|{end:.2f}|>").input_ids
    else:
        ids = tokenizer(f" {text}").input_ids
    return ids


class Batcher:
    def __init__(self, processor, data_dir, decoder_start_id, timestamp_ratio, rng):
        self.processor = processor
        self.data_dir = Path(data_dir)
        self.decoder_start_id = decoder_start_id
        self.timestamp_ratio = timestamp_ratio
        self.rng = rng

    def __call__(self, rows, with_timestamps=None):
        audio = [sf.read(str(self.data_dir / r["audio"]), dtype="float32")[0] for r in rows]
        features = self.processor.feature_extractor(
            audio, sampling_rate=16000, return_tensors="pt"
        ).input_features
        labels = []
        for r in rows:
            ts = (
                with_timestamps
                if with_timestamps is not None
                else self.rng.random() < self.timestamp_ratio
            )
            ids = encode_labels(self.processor.tokenizer, r["text"], r["duration"], ts)
            if ids[0] == self.decoder_start_id:
                ids = ids[1:]  # the model prepends it when shifting labels right
            labels.append(ids)
        width = max(len(x) for x in labels)
        label_tensor = torch.full((len(labels), width), -100, dtype=torch.long)
        for i, ids in enumerate(labels):
            label_tensor[i, : len(ids)] = torch.tensor(ids)
        return features, label_tensor


@torch.no_grad()
def eval_loss(model, batcher, rows, batch_size, device):
    model.eval()
    total, count = 0.0, 0
    for i in range(0, len(rows), batch_size):
        features, labels = batcher(rows[i : i + batch_size], with_timestamps=False)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            out = model(
                input_features=features.to(device, torch.bfloat16), labels=labels.to(device)
            )
        total += out.loss.item() * len(labels)
        count += len(labels)
    return total / count


@torch.no_grad()
def eval_wer(model, processor, batcher, rows, batch_size, device):
    model.eval()
    hyps, refs = [], []
    for i in range(0, len(rows), batch_size):
        chunk = rows[i : i + batch_size]
        features, _ = batcher(chunk, with_timestamps=False)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            ids = model.generate(
                input_features=features.to(device, torch.bfloat16),
                language="cs",
                task="transcribe",
                max_new_tokens=440,
            )
        hyps += [t.strip() for t in processor.batch_decode(ids, skip_special_tokens=True)]
        refs += [r["text"] for r in chunk]
    return jiwer.wer(refs, hyps), hyps[:3], refs[:3]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=int, default=2)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=4)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--lora-r", type=int, default=32)
    p.add_argument("--timestamp-ratio", type=float, default=0.5)
    p.add_argument("--eval-spans", type=int, default=40)
    p.add_argument(
        "--max-train-chunks",
        type=int,
        default=None,
        help="Cap the training chunks, for a quick run",
    )
    p.add_argument("--seed", type=int, default=20261010)
    args = p.parse_args()

    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    device = "cuda"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report = {"base": BASE, "args": vars(args)}

    processor = WhisperProcessor.from_pretrained(BASE)
    model = WhisperForConditionalGeneration.from_pretrained(BASE, dtype=torch.bfloat16).to(device)
    model.config.use_cache = False
    base_alignment_heads = model.generation_config.alignment_heads
    report["base_alignment_heads"] = len(base_alignment_heads or [])

    tok = processor.tokenizer
    ts_begin = tok.convert_tokens_to_ids("<|0.00|>")
    probe = encode_labels(tok, "Dobrý den.", 1.23, True)
    assert probe.count(ts_begin) == 1 and sum(t >= ts_begin for t in probe) == 2, probe
    assert tok.convert_tokens_to_ids("<|notimestamps|>") in encode_labels(
        tok, "Dobrý den.", 1.23, False
    )
    report["label_probe"] = tok.convert_ids_to_tokens(probe)

    train = load_rows(args.data, "train")
    test = load_rows(args.data, "test")
    rng.shuffle(train)
    if args.max_train_chunks is not None:
        train = train[: args.max_train_chunks]
    if not train:
        raise SystemExit("The dataset has no training chunks")
    eval_rows = test[: args.eval_spans]
    report["train_spans"], report["test_spans"] = len(train), len(test)
    batcher = Batcher(
        processor, args.data, model.config.decoder_start_token_id, args.timestamp_ratio, rng
    )

    t0 = time.time()
    if eval_rows:
        report["before"] = {
            "test_loss": eval_loss(model, batcher, eval_rows, args.batch_size, device)
        }
        wer, hyps, refs = eval_wer(model, processor, batcher, eval_rows, args.batch_size, device)
        report["before"]["test_wer"] = wer
        print("before:", report["before"], flush=True)

    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=2 * args.lora_r,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "out_proj", "fc1", "fc2"],
    )
    model = get_peft_model(model, lora)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    report["trainable_params"] = trainable
    model.base_model.model.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )
    optimizer = torch.optim.AdamW(
        [p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.0
    )

    micro_steps = args.epochs * math.ceil(len(train) / args.batch_size)
    total_steps = math.ceil(micro_steps / args.grad_accum)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lambda s: min(1.0, (s + 1) / max(1, total_steps // 10)) * max(0.0, 1 - s / total_steps),
    )
    torch.cuda.reset_peak_memory_stats()
    losses, step = [], 0
    model.train()
    for epoch in range(args.epochs):
        rng.shuffle(train)
        for i in range(0, len(train), args.batch_size):
            features, labels = batcher(train[i : i + args.batch_size])
            with torch.autocast("cuda", dtype=torch.bfloat16):
                out_ = model(
                    input_features=features.to(device, torch.bfloat16), labels=labels.to(device)
                )
            (out_.loss / args.grad_accum).backward()
            losses.append(out_.loss.item())
            if (i // args.batch_size + 1) % args.grad_accum == 0:
                torch.nn.utils.clip_grad_norm_(
                    [p for p in model.parameters() if p.requires_grad], 1.0
                )
                optimizer.step()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)
                step += 1
                if step % 5 == 0:
                    print(
                        f"epoch {epoch} step {step}/{total_steps} loss {sum(losses[-20:]) / len(losses[-20:]):.4f}",
                        flush=True,
                    )
    report["optimizer_steps"] = step
    report["train_loss_first20"] = sum(losses[:20]) / len(losses[:20])
    report["train_loss_last20"] = sum(losses[-20:]) / len(losses[-20:])
    report["peak_gpu_gib"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
    report["train_minutes"] = round((time.time() - t0) / 60, 1)

    model.save_pretrained(out / "lora_adapter")
    merged = model.merge_and_unload()
    merged.config.use_cache = True
    if eval_rows:
        report["after"] = {
            "test_loss": eval_loss(merged, batcher, eval_rows, args.batch_size, device)
        }
        wer, hyps, refs = eval_wer(merged, processor, batcher, eval_rows, args.batch_size, device)
        report["after"]["test_wer"] = wer
        report["samples"] = [{"ref": r, "hyp": h} for r, h in zip(refs, hyps)]
        print("after:", report["after"], flush=True)

    merged_dir = out / "merged"
    merged.generation_config.alignment_heads = base_alignment_heads
    merged.save_pretrained(merged_dir)
    processor.save_pretrained(merged_dir)
    # transformers 5 writes processor_config.json; faster-whisper reads the mel
    # count (128 for large-v3) from preprocessor_config.json and assumes 80 without it.
    processor.feature_extractor.save_pretrained(merged_dir)
    saved = json.loads((merged_dir / "generation_config.json").read_text())
    assert saved.get("alignment_heads") == base_alignment_heads, "alignment heads lost"
    assert json.loads((merged_dir / "preprocessor_config.json").read_text())["feature_size"] == 128
    report["merged_files"] = sorted(x.name for x in merged_dir.iterdir())
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        json.dumps(
            {k: v for k, v in report.items() if k != "samples"}, indent=2, ensure_ascii=False
        )
    )


if __name__ == "__main__":
    main()
