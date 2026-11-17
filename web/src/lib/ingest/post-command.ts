import { z } from "zod";

/**
 * Placeholders the host worker fills into the post-ingest command. Keep in
 * line with POST_INGEST_PLACEHOLDERS in
 * besedy/lib/prefect_jobs/flows/ingest_recording.py.
 */
export const POST_INGEST_PLACEHOLDERS = [
  "event_id",
  "audio_hash",
  "catalog_id",
  "intake_id",
] as const;

export const POST_INGEST_COMMAND_MAX_LENGTH = 2000;

const PLACEHOLDER_RE = /\{([a-z_]+)\}/g;

export function unknownPostIngestPlaceholders(command: string): string[] {
  const known = new Set<string>(POST_INGEST_PLACEHOLDERS);
  const unknown = new Set<string>();
  for (const match of command.matchAll(PLACEHOLDER_RE)) {
    if (!known.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown].sort();
}

/** Empty means no command; the worker splits the value like a shell, without one. */
export const postIngestCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .max(POST_INGEST_COMMAND_MAX_LENGTH)
    .refine((command) => !/[\r\n\0]/.test(command), {
      message: "The command must be a single line",
    })
    .refine((command) => unknownPostIngestPlaceholders(command).length === 0, {
      message: `Unknown placeholder; use ${POST_INGEST_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
    })
    .transform((command) => command || null)
    .nullable(),
});

export const postIngestCommandResponseSchema = z.object({
  command: z.string().nullable(),
});
