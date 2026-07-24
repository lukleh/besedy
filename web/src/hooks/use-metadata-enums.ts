import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";

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
const artistsSchema = z.array(z.string());
const duplicateCountsSchema = z.array(z.number());

/**
 * Fetch the list of recorders for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useRecorders() {
  return useQuery<MetadataRecorder[]>({
    queryKey: ["metadata", "recorders"],
    queryFn: async () => {
      try {
        return await fetchJson<MetadataRecorder[]>("/api/metadata/recorders", {
          schema: metadataEnumsSchema,
        });
      } catch {
        return [];
      }
    },
  });
}

/**
 * Fetch the list of locations for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useLocations() {
  return useQuery<MetadataLocation[]>({
    queryKey: ["metadata", "locations"],
    queryFn: async () => {
      try {
        return await fetchJson<MetadataLocation[]>("/api/metadata/locations", {
          schema: metadataEnumsSchema,
        });
      } catch {
        return [];
      }
    },
  });
}

/**
 * Fetch distinct artist values from the catalog's metadata CSV.
 * Returns real values that exist in the current catalog.
 * Returns empty array on error for graceful degradation.
 *
 * @param groupId - Optional catalog ID. If not provided, uses active group from server.
 */
export function useArtists(groupId?: string) {
  return useQuery<string[]>({
    queryKey: ["metadata", "artists", groupId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (groupId) params.set("group", groupId);
      const url = `/api/metadata/artists${params.toString() ? `?${params}` : ""}`;
      try {
        return await fetchJson<string[]>(url, {
          schema: artistsSchema,
        });
      } catch {
        return [];
      }
    },
  });
}

/**
 * Fetch the list of albums for metadata selection.
 * Returns empty array on error for graceful degradation.
 */
export function useAlbums() {
  return useQuery<MetadataAlbum[]>({
    queryKey: ["metadata", "albums"],
    queryFn: async () => {
      try {
        return await fetchJson<MetadataAlbum[]>("/api/metadata/albums", {
          schema: metadataEnumsSchema,
        });
      } catch {
        return [];
      }
    },
  });
}

/**
 * Fetch distinct duplicate count values from the catalog's duplicates CSV.
 * Returns real values that exist in the current catalog.
 * Returns empty array on error for graceful degradation.
 *
 * @param groupId - Optional catalog ID. If not provided, uses active group from server.
 */
export function useDuplicateCounts(groupId?: string) {
  return useQuery<number[]>({
    queryKey: ["metadata", "duplicateCounts", groupId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (groupId) params.set("group", groupId);
      const url = `/api/metadata/duplicate-counts${params.toString() ? `?${params}` : ""}`;
      try {
        return await fetchJson<number[]>(url, {
          schema: duplicateCountsSchema,
        });
      } catch {
        return [];
      }
    },
  });
}
