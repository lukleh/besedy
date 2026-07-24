import fs from "fs/promises";
import path from "path";
import { getSourcesDir } from "@/lib/config";
import type { RecordingSource } from "@/types/recording-sources";

const SOURCES_FILENAME = "sources.json";

interface EventSourcesFile {
  version: 1;
  sources: RecordingSource[];
}

export function resolveEventSourcesRoot(groupId: string): string {
  return path.join(getSourcesDir(), `sources_${groupId}`, "events");
}

export function resolveEventSourcesDir(groupId: string, eventId: number): string {
  return path.join(resolveEventSourcesRoot(groupId), String(eventId));
}

export function getEventSourcesFilePath(groupId: string, eventId: number): string {
  return path.join(resolveEventSourcesDir(groupId, eventId), SOURCES_FILENAME);
}

export async function readEventSources(
  groupId: string,
  eventId: number
): Promise<RecordingSource[]> {
  const filePath = getEventSourcesFilePath(groupId, eventId);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as EventSourcesFile | RecordingSource[] | null;
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.sources)) {
      return parsed.sources;
    }
  } catch {
    // Missing or invalid file -> treat as no sources
  }
  return [];
}

export async function writeEventSources(
  dir: string,
  sources: RecordingSource[]
): Promise<void> {
  const payload: EventSourcesFile = { version: 1, sources };
  const filePath = path.join(dir, SOURCES_FILENAME);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}
