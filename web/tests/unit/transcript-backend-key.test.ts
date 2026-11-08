import { describe, expect, it } from "vitest";
import { parseTranscriptBackendKey } from "@/lib/transcript-backend-key";

describe("parseTranscriptBackendKey", () => {
  it.each([
    "faster-whisper/large-v3@silero_vad_v6@lang-cs",
    "canary-nemo/nvidia_canary-1b-v2@lang-auto",
    "whisperx/large-v3@lang-eng",
    "custom-workflow/custom-model@lang-en-us",
    "custom-workflow/custom-model@lang-eng-cze",
    "corrected/published",
  ])("accepts the current key %s", (backend) => {
    const [workflow, model] = backend.split("/");
    expect(parseTranscriptBackendKey(backend)).toEqual({ workflow, model });
  });

  it.each([
    "faster-whisper/large-v3@silero_vad_v6",
    "faster-whisper/large-v3@lang-c",
    "faster-whisper/large-v3@lang-czech",
    "faster-whisper/large-v3@lang-CS",
    "faster-whisper/large-v3@lang-en-US",
    "faster-whisper/large-v3@lang-cs-extra-long",
    "faster-whisper/large-v3@lang-cs@extra",
    "corrected/other@lang-cs",
    "corrected/published@lang-cs",
    "faster-whisper/../large-v3@lang-cs",
    "faster-whisper\\other/large-v3@lang-cs",
    "../large-v3@lang-cs",
    "/large-v3@lang-cs",
    "faster-whisper/",
    "faster-whisper",
  ])("rejects unsupported or unsafe key %s", (backend) => {
    expect(parseTranscriptBackendKey(backend)).toBeNull();
  });
});
