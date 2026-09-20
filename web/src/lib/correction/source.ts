import fs from "node:fs/promises";
import path from "node:path";
import { getAvailableTranscripts } from "@/lib/transcript";
import { listTranscriptBackendPriorities } from "@/lib/transcript-priority";
import { validatePath } from "@/lib/security/path-validation";
import { CorrectionError } from "@/lib/correction/errors";

/** One segment of a canonical machine transcript, as stored on disk. */
export interface CanonicalSegment {
  start?: number;
  end?: number;
  text?: string;
  [key: string]: unknown;
}

export interface CanonicalTranscript {
  meta?: Record<string, unknown>;
  segments?: CanonicalSegment[];
  [key: string]: unknown;
}

export interface MachineSource {
  backend: string;
  /** Raw file bytes as text, frozen verbatim so provenance survives */
  content: string;
  data: CanonicalTranscript;
}

/**
 * The backend the reader currently calls the default one.
 *
 * Three mechanisms in this codebase could claim the name: this priority
 * table, the `RAG_BACKEND_KEY` used by export and search, and the MCP
 * canonical list. Correction freezes what the reader would show, because that
 * is the text a corrector is looking at when they decide to start.
 */
export async function resolveConfiguredDefaultBackend(
  transcriptsPath: string,
  audioHash: string
): Promise<string | null> {
  const priorities = await listTranscriptBackendPriorities();
  const available = await getAvailableTranscripts(transcriptsPath, audioHash, {
    priorities,
  });
  return available.backends[0] ?? null;
}

function parseBackendKey(backend: string): { workflow: string; model: string } {
  const [workflow, model, ...rest] = backend.split("/");
  if (!workflow || !model || rest.length > 0) {
    throw new CorrectionError("SOURCE_MISSING", `Invalid backend key: ${backend}`);
  }
  return { workflow, model };
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
    data = JSON.parse(content) as CanonicalTranscript;
  } catch {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `Machine transcript for backend ${backend} is not valid JSON`
    );
  }

  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    throw new CorrectionError(
      "SOURCE_MISSING",
      `Machine transcript for backend ${backend} has no segments`
    );
  }

  return { backend, content, data };
}
