import fs from "fs/promises";
import path from "path";
import { validatePath } from "@/lib/security/path-validation";

/**
 * Validate that a transcripts path is within allowed directories.
 * Throws an error if the path is invalid.
 */
function requireValidTranscriptsPath(transcriptsPath: string): string {
  const result = validatePath(transcriptsPath);
  if (!result.valid) {
    throw new Error(`Invalid transcripts path: ${result.reason}`);
  }
  return result.resolvedPath;
}

/**
 * Resolve a subpath under the transcripts base directory and ensure it stays within it.
 * This is a defense-in-depth guard against path traversal if callers forget to validate input.
 */
function resolveTranscriptSubpath(baseDir: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\")
    ) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }

  const joined = path.join(baseDir, ...segments);
  const resolvedBase = path.resolve(baseDir);
  const resolvedJoined = path.resolve(joined);
  const relative = path.relative(resolvedBase, resolvedJoined);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolvedJoined;
  }

  throw new Error(`Resolved path escapes transcripts base directory: ${joined}`);
}

/**
 * Transcript backend key (workflow/model_component).
 */
export type TranscriptBackend = string;

/**
 * Word-level segment from ASR transcripts
 */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

/**
 * Segment from ASR transcripts
 */
export interface TranscriptSegment {
  id?: number;
  text: string;
  start: number;
  end: number;
  words?: TranscriptWord[];
  speaker?: string;
}

/**
 * Base transcript structure
 */
export interface Transcript {
  backend: TranscriptBackend;
  hash: string;
  model?: string;
  language?: string;
  duration?: number;
}

/**
 * ASR transcript (word-level)
 */
export interface ASRTranscript extends Transcript {
  backend: TranscriptBackend;
  segments: TranscriptSegment[];
}

function parseBackendKey(backendKey: string): { workflow: string; model: string } {
  const parts = backendKey.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid backend key: ${backendKey}`);
  }
  const [workflow, model] = parts;
  if (!workflow || !model) {
    throw new Error(`Invalid backend key: ${backendKey}`);
  }
  if (workflow === "." || workflow === ".." || model === "." || model === "..") {
    throw new Error(`Invalid backend key: ${backendKey}`);
  }
  if (workflow.includes("\\") || model.includes("\\")) {
    throw new Error(`Invalid backend key: ${backendKey}`);
  }
  return { workflow, model };
}

/**
 * Download format for transcripts
 */
export type TranscriptFormat = "json" | "txt" | "srt" | "vtt";

/**
 * Available transcripts for a recording
 */
export interface AvailableTranscripts {
  hash: string;
  backends: TranscriptBackend[];
}

/**
 * Available formats for a specific backend
 */
export interface AvailableFormats {
  backend: TranscriptBackend;
  formats: TranscriptFormat[];
}

export async function discoverTranscriptBackends(
  transcriptRoots: string[]
): Promise<TranscriptBackend[]> {
  const backends = new Set<TranscriptBackend>();

  for (const root of transcriptRoots) {
    let validatedRoot: string;
    try {
      validatedRoot = requireValidTranscriptsPath(root);
    } catch {
      continue;
    }

    let workflowDirs: import("fs").Dirent[];
    try {
      workflowDirs = (await fs.readdir(validatedRoot, {
        withFileTypes: true,
      })) as import("fs").Dirent[];
    } catch {
      continue;
    }

    for (const workflowDir of workflowDirs) {
      if (!workflowDir.isDirectory()) continue;
      if (workflowDir.name.startsWith(".")) continue;
      if (workflowDir.name === "speaker_diarization") continue;

      const workflowPath = path.join(validatedRoot, workflowDir.name);
      let modelDirs: import("fs").Dirent[];
      try {
        modelDirs = (await fs.readdir(workflowPath, {
          withFileTypes: true,
        })) as import("fs").Dirent[];
      } catch {
        continue;
      }

      for (const modelDir of modelDirs) {
        if (!modelDir.isDirectory()) continue;
        if (modelDir.name.startsWith(".")) continue;
        backends.add(`${workflowDir.name}/${modelDir.name}`);
      }
    }
  }

  return Array.from(backends).sort();
}

export function orderTranscriptBackends(
  backends: TranscriptBackend[],
  priorities: Record<string, number> = {}
): TranscriptBackend[] {
  const sorted = [...backends];
  const hasPriorities = Object.keys(priorities).length > 0;

  if (!hasPriorities) {
    return sorted.sort();
  }

  return sorted.sort((a, b) => {
    const priorityA = priorities[a];
    const priorityB = priorities[b];
    const normalizedA =
      typeof priorityA === "number" && Number.isFinite(priorityA) ? priorityA : 0;
    const normalizedB =
      typeof priorityB === "number" && Number.isFinite(priorityB) ? priorityB : 0;

    if (normalizedA !== normalizedB) {
      return normalizedB - normalizedA;
    }

    return a.localeCompare(b);
  });
}

/**
 * Find available transcript backends for a recording
 */
export async function getAvailableTranscripts(
  transcriptsPath: string,
  hash: string,
  options?: { priorities?: Record<string, number> }
): Promise<AvailableTranscripts> {
  const validatedPath = requireValidTranscriptsPath(transcriptsPath);

  const backends: TranscriptBackend[] = [];

  let workflowDirs: import("fs").Dirent[];
  try {
    workflowDirs = (await fs.readdir(validatedPath, {
      withFileTypes: true,
    })) as import("fs").Dirent[];
  } catch {
    return { hash, backends };
  }

  for (const workflowDir of workflowDirs) {
    if (!workflowDir.isDirectory()) continue;
    if (workflowDir.name.startsWith(".")) continue;
    if (workflowDir.name === "speaker_diarization") continue;

    try {
      const workflowPath = path.join(validatedPath, workflowDir.name);
      const modelDirs = await fs.readdir(workflowPath, { withFileTypes: true });

      for (const modelDir of modelDirs) {
        if (!modelDir.isDirectory()) continue;
        if (modelDir.name.startsWith(".")) continue;

        const transcriptPath = resolveTranscriptSubpath(
          validatedPath,
          workflowDir.name,
          modelDir.name,
          hash,
          "transcript.json"
        );
        try {
          await fs.access(transcriptPath);
          backends.push(`${workflowDir.name}/${modelDir.name}`);
        } catch {
          // Transcript missing for this model/hash
        }
      }
    } catch {
      // Workflow not available
    }
  }

  const ordered = orderTranscriptBackends(backends, options?.priorities);
  return { hash, backends: ordered };
}

/**
 * Load a transcript for a specific backend
 */
export async function loadTranscript(
  transcriptsPath: string,
  hash: string,
  backend: TranscriptBackend
): Promise<ASRTranscript | null> {
  try {
    const validatedPath = requireValidTranscriptsPath(transcriptsPath);
    const { workflow, model } = parseBackendKey(backend);
    const transcriptPath = resolveTranscriptSubpath(
      validatedPath,
      workflow,
      model,
      hash,
      "transcript.json"
    );
    const content = await fs.readFile(transcriptPath, "utf-8");
    const data = JSON.parse(content);

    return {
      backend,
      hash,
      model,
      language: data.language,
      duration: data.duration,
      segments: data.segments || [],
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the transcript directory path for a backend/hash combination
 * Returns null if the transcript doesn't exist
 */
export async function resolveTranscriptDir(
  transcriptsPath: string,
  hash: string,
  backend: TranscriptBackend
): Promise<string | null> {
  try {
    const validatedPath = requireValidTranscriptsPath(transcriptsPath);
    const { workflow, model } = parseBackendKey(backend);
    const transcriptDir = resolveTranscriptSubpath(
      validatedPath,
      workflow,
      model,
      hash
    );
    const transcriptFile = path.join(transcriptDir, "transcript.json");
    await fs.access(transcriptFile);
    return transcriptDir;
  } catch {
    return null;
  }
}

async function requireTranscriptDir(
  transcriptsPath: string,
  hash: string,
  backend: TranscriptBackend
): Promise<string> {
  const transcriptDir = await resolveTranscriptDir(
    transcriptsPath,
    hash,
    backend
  );
  if (!transcriptDir) {
    throw new Error("Transcript directory not found");
  }
  return transcriptDir;
}

/**
 * Get available download formats for a transcript
 * Checks which sidecar files exist on disk
 */
export async function getAvailableFormats(
  transcriptsPath: string,
  hash: string,
  backend: TranscriptBackend
): Promise<AvailableFormats | null> {
  try {
    const transcriptDir = await requireTranscriptDir(
      transcriptsPath,
      hash,
      backend
    );
    const formats: TranscriptFormat[] = [];

    // ASR backends have transcript.{json,txt,srt,vtt}
    const formatFiles: { format: TranscriptFormat; filename: string }[] = [
      { format: "json", filename: "transcript.json" },
      { format: "txt", filename: "transcript.txt" },
      { format: "srt", filename: "transcript.srt" },
      { format: "vtt", filename: "transcript.vtt" },
    ];

    for (const { format, filename } of formatFiles) {
      try {
        await fs.access(path.join(transcriptDir, filename));
        formats.push(format);
      } catch {
        // Format not available
      }
    }

    return { backend, formats };
  } catch {
    return null;
  }
}

/**
 * Read transcript file content in a specific format
 * Returns the raw file content or null if not available
 */
export async function readTranscriptFile(
  transcriptsPath: string,
  hash: string,
  backend: TranscriptBackend,
  format: TranscriptFormat
): Promise<{ content: string; filename: string } | null> {
  try {
    const transcriptDir = await requireTranscriptDir(
      transcriptsPath,
      hash,
      backend
    );
    const filename = `transcript.${format}`;

    const filePath = path.join(transcriptDir, filename);
    const content = await fs.readFile(filePath, "utf-8");
    return { content, filename };
  } catch {
    return null;
  }
}

/**
 * Format transcript text as plain text (kept for backward compatibility)
 * @deprecated Use readTranscriptFile with format="txt" instead
 */
export function formatTranscriptText(transcript: ASRTranscript): string {
  return transcript.segments.map((s) => s.text).join(" ");
}

/**
 * Speaker segment from diarization
 */
export interface SpeakerSegment {
  start: number;
  end: number;
  speaker: string;
}

/**
 * Diarization result
 */
export interface Diarization {
  hash: string;
  model: string;
  numSpeakers: number;
  segments: SpeakerSegment[];
}

/**
 * Available diarization backends
 */
export type DiarizationBackend = "pyannote";

/**
 * Find available diarization backends for a recording
 */
export async function getAvailableDiarizations(
  transcriptsPath: string,
  hash: string
): Promise<DiarizationBackend[]> {
  // Validate transcripts path is within allowed directories
  const validatedPath = requireValidTranscriptsPath(transcriptsPath);

  const backends: DiarizationBackend[] = [];
  const diarizationDir = path.join(validatedPath, "speaker_diarization");

  const diarizationBackends: { backend: DiarizationBackend; pattern: string }[] = [
    { backend: "pyannote", pattern: "pyannote_" },
  ];

  for (const { backend, pattern } of diarizationBackends) {
    try {
      const entries = await fs.readdir(diarizationDir, { withFileTypes: true });
      const modelDir = entries.find(
        (d) => d.isDirectory() && d.name.startsWith(pattern)
      );

      if (modelDir) {
        const speakersPath = resolveTranscriptSubpath(
          validatedPath,
          "speaker_diarization",
          modelDir.name,
          hash,
          "speakers.json"
        );
        await fs.access(speakersPath);
        backends.push(backend);
      }
    } catch {
      // Backend not available
    }
  }

  return backends;
}

/**
 * Load diarization for a specific backend
 */
export async function loadDiarization(
  transcriptsPath: string,
  hash: string,
  backend: DiarizationBackend
): Promise<Diarization | null> {
  try {
    if (backend !== "pyannote") {
      return null;
    }

    // Validate transcripts path is within allowed directories
    const validatedPath = requireValidTranscriptsPath(transcriptsPath);

    const diarizationDir = path.join(validatedPath, "speaker_diarization");
    const pattern = "pyannote_";

    const entries = await fs.readdir(diarizationDir, { withFileTypes: true });
    const modelDir = entries.find(
      (d) => d.isDirectory() && d.name.startsWith(pattern)
    );

    if (!modelDir) return null;

    const speakersPath = resolveTranscriptSubpath(
      validatedPath,
      "speaker_diarization",
      modelDir.name,
      hash,
      "speakers.json"
    );
    const content = await fs.readFile(speakersPath, "utf-8");
    const data = JSON.parse(content);

    return {
      hash,
      model: modelDir.name,
      numSpeakers: data.num_speakers,
      segments: data.segments || [],
    };
  } catch {
    return null;
  }
}
