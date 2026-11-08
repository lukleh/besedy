import fs from "node:fs/promises";
import path from "node:path";
import { getAvailableTranscripts } from "@/lib/transcript";
import { listTranscriptBackendPriorities } from "@/lib/transcript-priority";
import { selectDefaultTranscriptBackend } from "@/lib/transcript-default";
import { validatePath } from "@/lib/security/path-validation";
import { CorrectionError } from "@/lib/correction/errors";
import { canonicalTranscriptSchema, type CanonicalTranscript } from "@/lib/transcript-schema";
import { RESERVED_TRANSCRIPT_WORKFLOW_DIR } from "@/lib/correction/backend-key";
import { parseTranscriptBackendKey } from "@/lib/transcript-backend-key";

export interface MachineSource {
  backend: string;
  /** Raw file bytes as text, frozen verbatim so provenance survives */
  content: string;
  data: CanonicalTranscript;
}

/**
 * The machine transcript the reader shows for this recording, which is what a
 * corrector is looking at when they decide to start.
 *
 * ADR 0006 names one default for every consumer: the search backend in
 * `RAG_BACKEND_KEY`. The priority table only orders the variants and supplies
 * the fallback when this recording lacks that backend's transcript.
 */
export async function resolveConfiguredDefaultBackend(
  transcriptsPath: string,
  audioHash: string
): Promise<string | null> {
  const priorities = await listTranscriptBackendPriorities();
  const available = await getAvailableTranscripts(transcriptsPath, audioHash, {
    priorities,
  });
  return selectDefaultTranscriptBackend(available.backends);
}

function parseBackendKey(backend: string): { workflow: string; model: string } {
  const parsed = parseTranscriptBackendKey(backend);
  if (!parsed || parsed.workflow === RESERVED_TRANSCRIPT_WORKFLOW_DIR) {
    throw new CorrectionError("SOURCE_MISSING", `Invalid backend key: ${backend}`);
  }
  return parsed;
}

/** Read the complete canonical transcript, keeping the bytes for the freeze. */
export async function readMachineSource(
  transcriptsPath: string,
  audioHash: string,
  backend: string
): Promise<MachineSource> {
  const validated = validatePath(transcriptsPath);
  if (!validated.valid) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `Invalid transcripts path: ${validated.reason}`
    );
  }

  const { workflow, model } = parseBackendKey(backend);
  const filePath = path.join(
    validated.resolvedPath,
    workflow,
    model,
    audioHash,
    "transcript.json"
  );

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `No machine transcript for backend ${backend}`
    );
  }

  let data: CanonicalTranscript;
  try {
    data = canonicalTranscriptSchema.parse(JSON.parse(content));
  } catch {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `Machine transcript for backend ${backend} is not a valid canonical transcript`
    );
  }

  if (data.segments.length === 0) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `Machine transcript for backend ${backend} has no segments`
    );
  }

  return { backend, content, data };
}
