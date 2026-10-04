"use client";

import { use, useEffect, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useHydratedBoolean } from "@/hooks/use-hydrated-state";
import { useAacUpgradeAvailable } from "@/hooks/use-aac-upgrade-available";
import { useDownloadRecord } from "@/hooks/use-downloads";
import { useLocalAudioSrc } from "@/hooks/use-local-package";
import { FormatUpgradeNotice } from "@/components/offline/format-upgrade-notice";
import { browserPrefersAacAudio } from "@/lib/audio-format";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildAudioDownloadUrl,
  buildAudioSourcePreferenceUrl,
  buildAudioSourcesUrl,
  buildAudioUrl,
} from "@/lib/api/recording-urls";
import { useRecordingEntry } from "@/hooks/use-recording-entry";
import {
  RecordingAudioSection,
  RecordingHeader,
  RecordingPageSkeleton,
  RecordingPageState,
  RecordingTranscriptSection,
  type RecordingHeadingContext,
} from "./recording-content-sections";
import { useRecordingPlayback } from "./use-recording-playback";

interface RecordingContentProps {
  params: Promise<{ catalogId: string; hash: string }> | { catalogId: string; hash: string };
  beforeAudioPlayer?: ReactNode;
  afterAudioPlayer?: ReactNode;
  downloadEventId?: number;
  headingContext?: RecordingHeadingContext;
  headerActions?: ReactNode;
  headerIdentity?: ReactNode;
  hideDefaultRecorder?: boolean;
  /** The page offers metadata editing elsewhere, as the event page's edit menu does. */
  hideMetadataEdit?: boolean;
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
  formats?: string[];
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
  formats: z.array(z.string()).optional(),
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

/** Longest the player waits for the audio format before it plays the WebM. */
export const FORMAT_WAIT_TIMEOUT_MS = 3000;

/**
 * True while `waiting` is, for at most FORMAT_WAIT_TIMEOUT_MS per `key` (the
 * recording): a slow sources or preference request then plays the WebM
 * instead of holding the page, and the next recording gets its own wait.
 */
function useBoundedWait(waiting: boolean, key: string): boolean {
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timeoutId = window.setTimeout(() => setTimedOutKey(key), FORMAT_WAIT_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [waiting, key]);
  return waiting && timedOutKey !== key;
}

export default function RecordingContent({
  params,
  beforeAudioPlayer,
  afterAudioPlayer,
  downloadEventId,
  headingContext,
  headerActions,
  headerIdentity,
  hideDefaultRecorder = false,
  hideMetadataEdit = false,
  skipCatalogValidation = false,
}: RecordingContentProps) {
  // Owns recording-detail query orchestration and state selection, while
  // playback behavior and view sections live in sibling modules.
  const resolvedParams: { catalogId: string; hash: string } = isPromiseParams(params) ? use(params) : params;
  const { catalogId, hash } = resolvedParams;
  const queryClient = useQueryClient();
  // Keep the legacy key so existing users keep their saved transcript view preference.
  // Reading is the default view. The stream is the administrative one, and is
  // only reachable by an account that may see the transcripts behind it.
  const [showTranscriptStream, setShowTranscriptStream] = useHydratedBoolean(
    "besedy-transcript-enabled",
    false
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
    handlePlayerSeek,
    handleSeek,
    isPlaying,
    seekRequest,
    setCurrentTime,
  } = useRecordingPlayback(catalogId, hash);

  // Build back link URL - filters are restored from localStorage automatically
  const backToListUrl = `/catalog/${catalogId}`;

  // Fetch saved audio source preference from database
  const { data: savedPreference, isLoading: preferenceLoading } = useQuery<AudioSourcePreference>({
    queryKey: ["audio-source-preference", hash, groupKey],
    queryFn: async () => {
      try {
        return await fetchJson<AudioSourcePreference>(buildAudioSourcePreferenceUrl(catalogId, hash), {
          schema: audioSourcePreferenceSchema,
        });
      } catch {
        return { hash, sourceId: null };
      }
    },
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  // Fetch available audio sources
  const { data: sourcesData, isLoading: sourcesLoading } = useQuery<AudioSourcesResponse>({
    queryKey: ["audio-variants", hash, groupKey],
    queryFn: async () => {
      try {
        return await fetchJson<AudioSourcesResponse>(buildAudioSourcesUrl(catalogId, hash), {
          schema: audioSourcesResponseSchema,
        });
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
      queryClient.invalidateQueries({
        queryKey: ["audio-source-preference", hash, groupKey],
      });
    },
  });

  // Determine current audio source (saved preference or default)
  const availableSources = sourcesData?.sources ?? [];
  const availableSourceIds = availableSources.map((source) => source.id);
  const preferredSource =
    savedPreference?.sourceId && availableSourceIds.includes(savedPreference.sourceId)
      ? savedPreference.sourceId
      : null;
  const audioSource = preferredSource || sourcesData?.defaultSource || "archived";
  // WebKit browsers get the AAC-in-MP4 copy when this source has one (#291).
  const selectedAudioUrl = buildAudioUrl(catalogId, hash, audioSource, availableSources, {
    preferAac: browserPrefersAacAudio(),
  });
  // A complete local package plays in preference to the network; the page
  // never learns how it is stored.
  const localAudioSrc = useLocalAudioSrc(catalogId, hash, selectedAudioUrl, availableSources.length > 0);
  // A WebM download from before the AAC copy, playing on WebKit, stops early;
  // offer the copy here as well as on the Downloads page.
  const downloadRecord = useDownloadRecord(catalogId, hash);
  const formatUpgrade =
    useAacUpgradeAvailable(downloadRecord, availableSources) && localAudioSrc !== null;

  const handleSourceChange = (sourceId: string) => {
    savePreference.mutate(sourceId);
  };

  // Fetch single catalog entry with permissions
  const { data, cachedData, isLoading, isValidatingAccess, error, isError } = useRecordingEntry({
    catalogId,
    hash,
    groupKey,
    enabled: !catalogNotFound && !catalogValidationLoading,
  });

  // Preserve the mounted recording UI while access is being revalidated in the
  // background. If the fresh request denies access, we still fail closed as
  // soon as that response resolves.
  const recording = data?.entry ?? (isValidatingAccess ? cachedData?.entry : undefined);

  // On WebKit the file depends on the selected source and whether it has an AAC
  // copy (#291); starting the player before both are known would first load
  // the WebM Safari cannot stream. A local package does not depend on them.
  const awaitingFormat = useBoundedWait(
    browserPrefersAacAudio() &&
      (sourcesLoading === true || preferenceLoading === true) &&
      !localAudioSrc,
    hash
  );
  if (catalogValidationLoading || (isLoading && !recording) || awaitingFormat) {
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
    window.open(buildAudioDownloadUrl(catalogId, hash, source), "_blank");
  };
  const audioUrl = localAudioSrc ?? selectedAudioUrl;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-6 sm:pt-6">
      <RecordingHeader
        hash={hash}
        recording={recording}
        headingContext={headingContext}
        headerActions={headerActions}
        headerIdentity={headerIdentity}
        hideDefaultRecorder={hideDefaultRecorder}
      />
      <RecordingAudioSection
        beforeAudioPlayer={
          formatUpgrade && downloadRecord ? (
            <>
              {beforeAudioPlayer}
              <FormatUpgradeNotice downloadKey={downloadRecord.key} />
            </>
          ) : (
            beforeAudioPlayer
          )
        }
        afterAudioPlayer={afterAudioPlayer}
        audioSource={audioSource}
        audioUrl={audioUrl}
        autoPlayOnSeek={autoPlayOnSeek}
        catalogId={catalogId}
        downloadEventId={downloadEventId}
        currentTimeSetter={setCurrentTime}
        hash={hash}
        headingContext={headingContext}
        onAudioDownload={handleAudioDownload}
        onAudioEnded={handleAudioEnded}
        onDurationChange={handleDurationChange}
        onPlayingChange={handlePlayingChange}
        onSeek={handlePlayerSeek}
        onSourceChange={handleSourceChange}
        permissions={hideMetadataEdit ? { ...data, canEditMetadata: false } : (data ?? {})}
        recording={recording}
        savedSourceId={savedPreference?.sourceId ?? null}
        seekRequest={seekRequest}
        sources={availableSources}
      />
      {data?.canViewTranscripts && (
        <RecordingTranscriptSection
          canDownloadTranscripts={data.canDownloadTranscripts ?? false}
          canSeeSpeakers={data.canSeeSpeakers ?? false}
          canSeeTranscriptVariants={data.canSeeTranscriptVariants ?? false}
          canCorrectTranscripts={data.canCorrectTranscripts ?? false}
          correctionEligible={data.correctionEligible ?? false}
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
