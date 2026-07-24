import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";

export interface WorkflowVariant {
  id: number;
  workflowGroupId: string;
  variant: string;
  label: string | null;
  isDefault: boolean;
  listeningArchivedCatalogPath: string | null;
  createdAt: string;
}

export interface Catalog {
  id: string;
  label: string | null;
  archivedCatalogPath: string;
  metadataCatalogPath: string;
  duplicatesCatalogPath: string | null;
  transcriptsPath: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  variants: WorkflowVariant[];
}

export const workflowVariantSchema = z.object({
  id: z.number(),
  workflowGroupId: z.string(),
  variant: z.string(),
  label: z.string().nullable(),
  isDefault: z.boolean(),
  listeningArchivedCatalogPath: z.string().nullable(),
  createdAt: z.string(),
}).strict();

export const catalogSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  archivedCatalogPath: z.string(),
  metadataCatalogPath: z.string(),
  duplicatesCatalogPath: z.string().nullable(),
  transcriptsPath: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  variants: z.array(workflowVariantSchema),
}).strict();

export const catalogsSchema = z.array(catalogSchema);

/**
 * Fetch the list of catalogs (workflow groups).
 */
export function useCatalogs(options?: { enabled?: boolean }) {
  return useQuery<Catalog[]>({
    queryKey: ["catalogs"],
    queryFn: () =>
      fetchJson<Catalog[]>("/api/catalogs", {
        schema: catalogsSchema,
      }),
    enabled: options?.enabled,
  });
}
