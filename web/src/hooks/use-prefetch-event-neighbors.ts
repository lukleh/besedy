'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { audioSourcesQueryOptions } from '@/app/(app)/catalog/[catalogId]/recording/[hash]/audio-sources-query';
import {
  buildEventArtworkPictureUrl,
  eventArtworkVariantForViewport,
} from '@/components/catalog/event-artwork-picture';
import {
  eventDetailQueryOptions,
  selectShownEventArtwork,
} from '@/components/catalog/event-detail-query';
import type { EventListQueryState } from '@/components/catalog/event-list-types';
import { eventSequenceQueryOptions } from '@/hooks/use-event-sequence-navigation';
import { recordingEntryQueryOptions } from '@/hooks/use-recording-entry';
import { buildEventPagePath } from '@/lib/api/recording-urls';

type PrefetchOptions = NonNullable<Parameters<ReturnType<typeof useRouter>['prefetch']>[1]>;
// Rendered in full, so the page shows at once instead of waiting for the server.
const FULL_PREFETCH = { kind: 'full' as PrefetchOptions['kind'] };

/** Queries normally drop their data once nothing shows it; preloaded data has
 * to survive until the next event mounts, which still refetches it. */
const PRELOAD_LIFETIME_MS = 60_000;
const RETAINED_IMAGE_LIMIT = 4;

// A loaded image stays reusable for the document while it is referenced.
const retainedImages = new Map<string, HTMLImageElement>();

function retainImage(url: string) {
  if (retainedImages.has(url)) return;
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  retainedImages.set(url, image);
  while (retainedImages.size > RETAINED_IMAGE_LIMIT) {
    const oldest = retainedImages.keys().next().value;
    if (oldest === undefined) break;
    retainedImages.delete(oldest);
  }
}

function prefersSavingData() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 300);
  return () => window.clearTimeout(id);
}

/** Loads what the previous and next events need to appear complete at once:
 * the route, the event, its first recording's entry and sources, its own
 * neighbors and its artwork. Audio and transcripts load only once shown. */
export function usePrefetchEventNeighbors(
  catalogId: string,
  neighborIds: number[],
  sequenceStates: EventListQueryState[],
) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const idsKey = neighborIds.join(',');

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').map(Number) : [];
    if (ids.length === 0) return;
    let cancelled = false;
    const keep = { staleTime: PRELOAD_LIFETIME_MS, gcTime: PRELOAD_LIFETIME_MS };

    const cancelIdle = whenIdle(() => {
      for (const id of ids) {
        router.prefetch(buildEventPagePath(catalogId, id), FULL_PREFETCH);
        for (const state of sequenceStates) {
          void queryClient.prefetchQuery({
            ...eventSequenceQueryOptions(catalogId, id, state),
            ...keep,
          });
        }
        queryClient
          .fetchQuery({ ...eventDetailQueryOptions(catalogId, id), ...keep })
          .then((detail) => {
            if (cancelled) return;
            const recording =
              detail.recordings.find((candidate) => candidate.isPrimary) ?? detail.recordings[0];
            if (recording) {
              void queryClient.prefetchQuery({
                ...recordingEntryQueryOptions(catalogId, recording.audioHash, catalogId),
                retry: false,
                ...keep,
              });
              void queryClient.prefetchQuery({
                ...audioSourcesQueryOptions(catalogId, recording.audioHash, catalogId),
                ...keep,
              });
            }
            const artwork = selectShownEventArtwork(detail);
            if (artwork && !prefersSavingData()) {
              retainImage(
                buildEventArtworkPictureUrl(
                  catalogId,
                  id,
                  artwork.artworkId,
                  eventArtworkVariantForViewport(),
                  artwork.source,
                ),
              );
            }
          })
          .catch(() => {
            // Preloading is best effort; the page loads normally when shown.
          });
      }
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [catalogId, idsKey, queryClient, router, sequenceStates]);
}
