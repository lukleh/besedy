"use client";

import { use, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useHydratedBoolean } from "@/hooks/use-hydrated-state";
import { fetchJson } from "@/lib/api/fetch-json";
import { useRecordingEntry } from "@/hooks/use-recording-entry";
import {
  RecordingAudioSection,
  RecordingHeader,
  RecordingPageSkeleton,
  RecordingPageState,
  RecordingTranscriptSection,
} from "./recording-content-sections";
import { useRecordingPlayback } from "./use-recording-playback";

interface RecordingContentProps {
  params: Promise<{ catalogId: string; hash: string }> | { catalogId: string; hash: string };
  afterAudioPlayer?: ReactNode;
  headerActions?: ReactNode;
  headerIdentity?: ReactNode;
  hideDefaultRecorder?: boolean;
  skipCatalogValidation?: boolean;
}

function isPromiseParams(
  value: RecordingContentProps["params"]
): value is Promise<{ catalogId: string; hash: string }> {
  return typeof (value as { then?: unknown }).then === "function";
}

interface AudioSource {
  id: string;
  label: string;
  type: "archived" | "listening";
  variant?: string;
  available: boolean;
}

interface AudioSourcesResponse {
  hash: string;
  sources: AudioSource[];
  defaultSource: string;
}

interface AudioSourcePreference {
  hash: string;
  sourceId: string | null;
}

const audioSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["archived", "listening"]),
  variant: z.string().optional(),
  available: z.boolean(),
});

const audioSourcesResponseSchema = z.object({
  hash: z.string(),
  sources: z.array(audioSourceSchema),
  defaultSource: z.string(),
});

const audioSourcePreferenceSchema = z.object({
  hash: z.string(),
  sourceId: z.string().nullable(),
});

function buildAudioUrl(
  catalogId: string,
  hash: string,
  audioSource: string,
  sources: AudioSource[]
) {
  const selectedSource = sources.find((source) => source.id === audioSource);
  if (selectedSource?.type === "listening" && selectedSource.variant) {
    const params = new URLSearchParams({
      source: "listening",
      variant: selectedSource.variant,
    });
    return `/api/catalogs/${catalogId}/recordings/${hash}/audio?${params.toString()}`;
  }

  return `/api/catalogs/${catalogId}/recordings/${hash}/audio`;
}

export default function RecordingContent({
  params,
  afterAudioPlayer,
  headerActions,
  headerIdentity,
  hideDefaultRecorder = false,
  skipCatalogValidation = false,
}: RecordingContentProps) {
  // Owns recording-detail query orchestration and state selection, while
  // playback behavior and view sections live in sibling modules.
  const resolvedParams: { catalogId: string; hash: string } = isPromiseParams(params)
    ? use(params)
    : params;
  const { catalogId, hash } = resolvedParams;
  const queryClient = useQueryClient();
  // Keep the legacy key so existing users keep their saved transcript view preference.
  const [showTranscriptStream, setShowTranscriptStream] = useHydratedBoolean(
    "besedy-transcript-enabled",
    true
  );
  const { groupKey, catalogNotFound, catalogValidationLoading } = useCatalogContext(catalogId, {
    skipCatalogValidation,
  });
  const {
    autoPlayOnSeek,
    currentTime,
    handleAudioEnded,
    handleDurationChange,
    handlePlayingChange,
    handleSeek,
    isPlaying,
    seekRequest,
    setCurrentTime,
  } = useRecordingPlayback(catalogId, hash);

  // Build back link URL - filters are restored from localStorage automatically
  const backToListUrl = `/catalog/${catalogId}`;

  // Fetch saved audio source preference from database
  const { data: savedPreference } = useQuery<AudioSourcePreference>({
    queryKey: ["audio-source-preference", hash, groupKey],
    queryFn: async () => {
      const params = new URLSearchParams({ hash, group: catalogId });
      try {
        return await fetchJson<AudioSourcePreference>(
          `/api/preferences/audio-source?${params.toString()}`,
          {
            schema: audioSourcePreferenceSchema,
          }
        );
      } catch {
        return { hash, sourceId: null };
      }
    },
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  // Fetch available audio sources
  const { data: sourcesData } = useQuery<AudioSourcesResponse>({
    queryKey: ["audio-variants", hash, groupKey],
    queryFn: async () => {
      try {
        return await fetchJson<AudioSourcesResponse>(
          `/api/catalogs/${catalogId}/recordings/${hash}/audio/sources`,
          {
            schema: audioSourcesResponseSchema,
          }
        );
      } catch {
        return { hash, sources: [], defaultSource: "archived" };
      }
    },
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  // Mutation to save audio source preference
  const savePreference = useMutation({
    mutationFn: async (sourceId: string) => {
      return fetchJson("/api/preferences/audio-source", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, sourceId, group: catalogId }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["audio-source-preference", hash, groupKey] });
    },
  });

  // Determine current audio source (saved preference or default)
  const availableSourceIds = sourcesData?.sources.map((s) => s.id) ?? [];
  const preferredSource =
    savedPreference?.sourceId && availableSourceIds.includes(savedPreference.sourceId)
      ? savedPreference.sourceId
      : null;
  const audioSource = preferredSource || sourcesData?.defaultSource || "archived";

  const handleSourceChange = (sourceId: string) => {
    savePreference.mutate(sourceId);
  };

  // Fetch single catalog entry with permissions
  const {
    data,
    cachedData,
    isLoading,
    isValidatingAccess,
    error,
    isError,
  } = useRecordingEntry({
    catalogId,
    hash,
    groupKey,
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  // Preserve the mounted recording UI while access is being revalidated in the
  // background. If the fresh request denies access, we still fail closed as
  // soon as that response resolves.
  const recording = data?.entry ?? (isValidatingAccess ? cachedData?.entry : undefined);

  if (catalogValidationLoading || (isLoading && !recording)) {
    return (
      <div className="space-y-3">
        <RecordingPageSkeleton />
        {afterAudioPlayer}
      </div>
    );
  }

  if (catalogNotFound) {
    return (
      <RecordingPageState
        variant="catalogNotFound"
        catalogId={catalogId}
        backToListUrl={backToListUrl}
        afterAudioPlayer={afterAudioPlayer}
      />
    );
  }

  if (error || isError || !recording) {
    return (
      <RecordingPageState
        variant="recordingNotFound"
        catalogId={catalogId}
        backToListUrl={backToListUrl}
        afterAudioPlayer={afterAudioPlayer}
      />
    );
  }

  if (!recording.isActionable) {
    return (
      <RecordingPageState
        variant="recordingUnavailable"
        catalogId={catalogId}
        backToListUrl={backToListUrl}
        afterAudioPlayer={afterAudioPlayer}
      />
    );
  }

  // Audio download handler
  const handleAudioDownload = (source: "original" | "archived") => {
    const params = new URLSearchParams({
      download: "true",
      source,
    });
    window.open(
      `/api/catalogs/${catalogId}/recordings/${hash}/audio?${params.toString()}`,
      "_blank"
    );
  };
  const audioUrl = buildAudioUrl(catalogId, hash, audioSource, sourcesData?.sources ?? []);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6">
      <RecordingHeader
        hash={hash}
        recording={recording}
        headerActions={headerActions}
        headerIdentity={headerIdentity}
        hideDefaultRecorder={hideDefaultRecorder}
      />
      <RecordingAudioSection
        afterAudioPlayer={afterAudioPlayer}
        audioSource={audioSource}
        audioUrl={audioUrl}
        autoPlayOnSeek={autoPlayOnSeek}
        catalogId={catalogId}
        currentTimeSetter={setCurrentTime}
        hash={hash}
        onAudioDownload={handleAudioDownload}
        onAudioEnded={handleAudioEnded}
        onDurationChange={handleDurationChange}
        onPlayingChange={handlePlayingChange}
        onSourceChange={handleSourceChange}
        permissions={data ?? {}}
        recording={recording}
        savedSourceId={savedPreference?.sourceId ?? null}
        seekRequest={seekRequest}
        sources={sourcesData?.sources ?? []}
      />
      {data?.canViewTranscripts && (
        <RecordingTranscriptSection
          canDownload={data.canDownload}
          catalogId={catalogId}
          currentTime={currentTime}
          hash={hash}
          isPlaying={isPlaying}
          onSeek={handleSeek}
          onToggleTranscriptStream={setShowTranscriptStream}
          showTranscriptStream={showTranscriptStream}
        />
      )}
    </div>
  );
}
