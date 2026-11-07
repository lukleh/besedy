import { z } from "zod";

export const preferencesResponseSchema = z.object({
  userId: z.string(),
  theme: z.string(),
  catalogColumns: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
}).strict();

export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;
