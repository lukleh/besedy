"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";

export const archiveSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
}).strict();

export type Archive = z.infer<typeof archiveSchema>;

/** The server-selected archive, subject to the current user's access. */
export function useArchive(options?: { enabled?: boolean }) {
  return useQuery<Archive>({
    queryKey: ["archive"],
    queryFn: () => fetchJson<Archive>("/api/archive", { schema: archiveSchema }),
    enabled: options?.enabled,
  });
}
