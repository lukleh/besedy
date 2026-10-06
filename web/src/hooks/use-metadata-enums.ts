import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import { catalogLookupsApiPath, type CatalogLookupResource } from "@/lib/catalog/lookup-paths";

export interface MetadataRecorder {
  id: number;
  name: string;
}

export interface MetadataLocation {
  id: number;
  name: string;
}

export interface MetadataAlbum {
  id: number;
  name: string;
}

const metadataEnumSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const metadataEnumsSchema = z.array(metadataEnumSchema);

type MetadataEnumItem = z.infer<typeof metadataEnumSchema>;

/** Lookup list of one catalog; waits until the catalog id is known. */
function useMetadataEnumQuery(resource: CatalogLookupResource, catalogId: string | undefined) {
  return useQuery<MetadataEnumItem[]>({
    queryKey: ["metadata", resource, catalogId],
    queryFn: async () => {
      try {
        return await fetchJson<MetadataEnumItem[]>(
          catalogLookupsApiPath(catalogId!, resource),
          { schema: metadataEnumsSchema }
        );
      } catch {
        return [];
      }
    },
    enabled: !!catalogId,
  });
}

/**
 * Fetch the catalog's recorders for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useRecorders(catalogId: string | undefined) {
  return useMetadataEnumQuery("recorders", catalogId);
}

/**
 * Fetch the catalog's locations for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useLocations(catalogId: string | undefined) {
  return useMetadataEnumQuery("locations", catalogId);
}

/**
 * Fetch the catalog's albums for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useAlbums(catalogId: string | undefined) {
  return useMetadataEnumQuery("albums", catalogId);
}
