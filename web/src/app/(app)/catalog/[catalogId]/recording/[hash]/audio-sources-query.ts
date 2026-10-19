import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildAudioSourcesUrl } from "@/lib/api/recording-urls";

interface AudioSource {
  id: string;
  label: string;
  type: "archived";
  available: boolean;
  formats?: string[];
}

export interface AudioSourcesResponse {
  hash: string;
  sources: AudioSource[];
  defaultSource: string;
}

const audioSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.literal("archived"),
  available: z.boolean(),
  formats: z.array(z.string()).optional(),
});

const audioSourcesResponseSchema = z.object({
  hash: z.string(),
  sources: z.array(audioSourceSchema),
  defaultSource: z.string(),
});

/** The audio sources request, shared by the recording page and by neighbor
 * preloading. */
export function audioSourcesQueryOptions(catalogId: string, hash: string) {
  return {
    queryKey: ["audio-variants", hash, catalogId] as const,
    queryFn: async (): Promise<AudioSourcesResponse> => {
      try {
        return await fetchJson<AudioSourcesResponse>(buildAudioSourcesUrl(catalogId, hash), {
          schema: audioSourcesResponseSchema,
        });
      } catch {
        return { hash, sources: [], defaultSource: "archived" };
      }
    },
  };
}
