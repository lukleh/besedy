import { z } from 'zod';

export const CATALOG_SYNC_SOURCE_KEYS = [
  'metadata',
  'archived',
  'duplicates',
] as const;

export const catalogSyncStatusResponseSchema = z.object({
  groupId: z.string(),
  sources: z.array(
    z.object({
      sourceKey: z.enum(CATALOG_SYNC_SOURCE_KEYS),
      status: z.enum(['SUCCESS', 'ERROR']),
      syncedAt: z.string(),
      lastSuccessfulAt: z.string().nullable(),
      lastError: z.string().nullable(),
      rowCount: z.number(),
    }),
  ),
});

export type CatalogSyncStatusResponse = z.infer<
  typeof catalogSyncStatusResponseSchema
>;
