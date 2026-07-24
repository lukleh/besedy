import { z } from "zod";

export const workflowGroupSummarySchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  archivedCatalogPath: z.string(),
  metadataCatalogPath: z.string(),
  duplicatesCatalogPath: z.string().nullable(),
  transcriptsPath: z.string().nullable(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export const preferencesResponseSchema = z.object({
  userId: z.string(),
  activeGroupId: z.string().nullable(),
  activeGroup: workflowGroupSummarySchema.nullable(),
  theme: z.string(),
  catalogColumns: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
}).strict();

export type WorkflowGroupSummary = z.infer<typeof workflowGroupSummarySchema>;
export type PreferencesResponse = z.infer<typeof preferencesResponseSchema>;
