# Downloadable ASR models for Besedy

Reviewed 8 November 2026 against publisher model cards, model files, and official
training repositories. The selection prioritizes Czech recordings, a 16 GB GPU,
usable transcript timing, and maintainable Docker workers.

## Practical shortlist

| Family | Assessment for Besedy |
|---|---|
| Whisper large-v3/turbo | Keep as the established baseline and correction source. Existing CTranslate2 and WhisperX workers already supply the integration and alignment paths. |
| Qwen3-ASR 0.6B/1.7B | Keep the existing optional family. Czech and supervised fine-tuning are supported. The native Transformers port changes runtime integration; it is not a new set of trained weights. [Publisher repository](https://github.com/QwenLM/Qwen3-ASR) |
| Nemotron Labs Unified 0.6B | Add as an optional offline workflow. It supplies a different ASR architecture, Czech support, and native RNNT timing. The publisher currently documents inference support; our partial training experiment does not reproduce its original combined offline/streaming objective. [Model card](https://huggingface.co/nvidia/nemotron-labs-unified-asr-0.6b) |
| CzechSpeech | Add as an optional WhisperX model variant. It is Czech-tuned and turbo-based, and reuses the existing backend. Its training is predominantly parliamentary speech; spontaneous conversation was not evaluated by the publisher. It needs separate alignment and has a non-commercial license, with commercial licensing available separately. [Model card](https://huggingface.co/moravianai/CzechSpeech) |
| ARK-ASR 0.6B/3B | The experimental 0.6B Docker integration hit generation-limit failures on a full Czech recording; keep it out of defaults. See [trial limitations](backends.md#optional-ark-asr-06b-candidate). Public weights, Apache-2.0, and explicit Czech support. The smaller name counts the decoder: there is also a separate roughly 0.6B audio encoder. Both use custom model code. [0.6B card](https://huggingface.co/Edge0/ARK-ASR-0.6B/blob/45776b56d58cdfb2e2eb632f7e110f38684633e0/README.md), [3B card](https://huggingface.co/Edge0/ARK-ASR-3B) |
| Meta Omnilingual v2 | Another worthwhile benchmark: start with CTC 1B v2. Czech is listed as `ces_Latn`; publisher estimates are about 3 GiB inference for CTC 1B and 6 GiB for LLM 1B with short clips on A100/BF16. It adds a fairseq2 runtime and timing work. These are December 2025 checkpoints, rather than a new 2026 release. [Repository](https://github.com/facebookresearch/omnilingual-asr), [language inventory](https://github.com/facebookresearch/omnilingual-asr/blob/main/src/omnilingual_asr/models/wav2vec2_llama/lang_ids.py) |

ARK and Meta were identified by the broader second pass. ARK 0.6B has a
separate experimental integration; its long-recording trial did not produce a
complete transcript. Meta remains a candidate for a later benchmark. Neither
warrants adding default pipeline work without held-out evaluation.

## Where Mistral fits

Mistral does publish downloadable speech models:

- [Voxtral Mini 3B 2507](https://huggingface.co/mistralai/Voxtral-Mini-3B-2507)
  and Small 24B list eight supported languages, excluding Czech.
- [Voxtral Mini 4B Realtime 2602](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602)
  lists thirteen, also excluding Czech. It is a public Apache-2.0 checkpoint,
  focused on live transcription.
- **Voxtral 3** expands coverage to Czech. The published offering is API access
  or vendor-arranged self-deployment. No public downloadable Voxtral 3 weights
  were found in the publisher's model collection during this review. Treat this
  as a possible external benchmark, rather than a local fine-tuning candidate.
  [Announcement](https://mistral.ai/news/voxtral-3/),
  [current speech documentation](https://docs.mistral.ai/studio/audio/speech-to-text/overview)

An older model's omitted language is not proof that it can never transcribe that
language. It does mean that Czech quality is unestablished and it is a lower
priority than models whose publishers explicitly support Czech.

## Other notable families

| Family | Reason to defer |
|---|---|
| Nemotron 3.5 ASR Streaming 0.6B | Czech-capable and trainable; our smoke passed. It overlaps Unified while live-streaming functionality is unnecessary for completed Besedy recordings. This is separate from the large 30B model. [Model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) |
| Nemotron 3.5 Transcribe 30B-A4B | Downloadable and Czech-capable, but its approximately 34B total parameters exceed this host's practical training budget. Quantized inference on larger hardware is a separate experiment. [Model card](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B) |
| Cohere Transcribe 2B | Public release with fourteen supported languages; Czech is absent from the published list. [Model card](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026) |
| Granite Speech 5.0 2B | Downloadable, but the publisher's supported ASR languages omit Czech. Its English ranking does not establish Czech suitability. [Model card](https://huggingface.co/ibm-granite/granite-speech-5.0-2b) |
| Fun-ASR-MLT-Nano-2512 | Compact, downloadable and explicitly Czech-capable. Its card still lists returning timestamps and model training as unfinished. The newer native Transformers example for the separate base Nano checkpoint should not be confused with this multilingual model. [Model card](https://huggingface.co/FunAudioLLM/Fun-ASR-MLT-Nano-2512) |
| VibeVoice-ASR | Downloadable, Czech-capable, with long-form speaker/segment output and an official LoRA recipe. Actual BF16 weights total approximately 8.674B parameters: about 16.16 GiB before activations, exceeding this GPU's approximately 15.92 GiB capacity. Quantization/offload needs separate validation. [Model card and weights](https://huggingface.co/microsoft/VibeVoice-ASR), [training recipe](https://github.com/microsoft/VibeVoice/tree/main/finetuning-asr) |
| BuzzASR/czech | Existing Whisper integration works, but its reported combined CER is worse than the listed original Whisper baseline. Keep it as an available experiment rather than another routine transcript. [Model card](https://huggingface.co/BuzzASR/czech) |

## Training and evaluation decisions

ARK publishes teacher-based on-policy distillation with FSDP2. That is different
from a small supervised LoRA experiment; a simpler adaptation would require its
own verification. Some card links use `main`, while the training repository's
default branch is `master`. [Official repository](https://github.com/AutoArk/open-audio-opd)

Meta publishes CTC and LLM fine-tuning recipes. Standard inference uses short
clips; the Unlimited v2 variant accepts long recordings but explicitly lacks a
supported fine-tuning recipe. [Inference documentation](https://github.com/facebookresearch/omnilingual-asr/blob/main/src/omnilingual_asr/models/inference/README.md),
[training recipes](https://github.com/facebookresearch/omnilingual-asr/tree/main/workflows/recipes/wav2vec2/asr)

Before selecting a new default, compare original checkpoints on the same
corrected, held-out Czech recordings, with consistent normalization. Measure
word accuracy, missing or repeated speech, timestamp quality, runtime and memory.
English short-form leaderboard averages do not determine the winner for long
Czech discussions. A smoke fine-tune proves optimizer/save/reload execution,
not generalization or improved recognition.

The optional integrations preserve the existing correction/search source.
Meta CTC 1B v2 is the next family to consider after evaluating ARK 0.6B.
Add further workers only when measured benefits justify maintaining them.
