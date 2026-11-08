# ARK-ASR optional backend

This image runs `Edge0/ARK-ASR-0.6B` independently of the existing Whisper,
Qwen and NeMo images. It uses PyTorch 2.11.0 with CUDA 12.8 and Transformers
4.57.6, the version recorded by the checkpoint. The entire Python runtime is
locked in `requirements.lock`; image builds run `pip check` and CPU imports,
including Silero VAD 6.2.0 with its packaged ONNX model.

Build a trial image without replacing an installed backend image:

```bash
BESEDY_ARK_ASR_IMAGE=besedy/ark-asr:trial \
  docker compose -f backends/docker-compose.yml build ark-asr
```

Set the same image variable when running the pipeline with that trial image.
The default image name is `besedy/ark-asr:local`.

## Model and inference protocol

The default model and all executable checkpoint code are pinned to revision
`45776b56d58cdfb2e2eb632f7e110f38684633e0`. Download a complete snapshot and load
the model, tokenizer and processor from that local directory. In particular,
the custom processor reads `processor_config.json` from a local path. A custom
local model must include its compatible tokenizer, processor, configuration
and custom Python modules alongside the weights.

The model requires `trust_remote_code=True`; review the pinned source before
changing that revision. Inference uses SDPA, left-padded text inputs, the
official neutral transcription prompt, expanded audio placeholders and the
upstream suppression of speech-generation/control tokens. The processor emits
`audios`, which must use the model's floating-point dtype. Bounded speech
chunks keep the audio encoder's input within its 30-second window. Silero ONNX
VAD stays on CPU; the ASR model runs on the selected GPU. Word alignment belongs
to the existing WhisperX alignment stage, rather than this image.

Each chunk has a 512-token decoding budget. A chunk that exhausts it without
finishing aborts the file rather than publishing capped text. Only a completely
successful file writes the atomic raw bundle; failed ASR blocks alignment.

This is an experimental integration. A real Czech recording exposed repetition
loops, and short-slice diagnostics produced unexpected English text. The full
pipeline run failed. Keep the backend opt-in for evaluation. It is not a new
default, and this work does
not establish reliable Czech quality or a supervised fine-tuning recipe.

The `0.6B` name describes the text decoder; the checkpoint also includes an
audio encoder. Treat this backend as an optional candidate until evaluated on
representative Czech recordings and corrected references. The model does not
provide a Czech-specific language switch or native word timestamps.

Sources:

- [Pinned checkpoint and custom code](https://huggingface.co/Edge0/ARK-ASR-0.6B/tree/45776b56d58cdfb2e2eb632f7e110f38684633e0)
- [Official Transformers inference script](https://github.com/AutoArk/open-audio-opd/blob/master/scripts/infer/ark_asr_transformers.py)
