'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Loader2, WifiOff } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { AudioPlayer } from '@/components/player/audio-player';
import { TranscriptContent } from '@/components/transcript/transcript-viewer-content';
import { Badge } from '@/components/ui/badge';
import { formatPartialDate } from '@/lib/date-format';
import {
  getSavedPlaybackPosition,
  isPlaybackCompleted,
  markPlaybackCompleted,
  savePlaybackPosition,
} from '@/lib/playback-position';
import {
  getDownloadBundle,
  type DownloadBundlePayload,
  type DownloadRecord,
} from '@/lib/offline/downloads-db';
import { queuePlaybackProgress } from '@/lib/offline/playback-progress-sync';
import { CircularBackButton } from '@/components/navigation/circular-back-control';

interface OfflineDownloadDetailProps {
  record: DownloadRecord | null;
  onBack: () => void;
}

export function OfflineDownloadDetail({
  record,
  onBack,
}: OfflineDownloadDetailProps) {
  const t = useTranslations('downloads');
  const locale = useLocale();
  const [bundleState, setBundleState] = useState<{
    key: string | null;
    bundle: DownloadBundlePayload | null;
  }>({ key: null, bundle: null });
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>();
  const [seekKey, setSeekKey] = useState(0);
  const playbackRef = useRef({
    time: 0,
    duration: 0,
    completed: false,
    lastSavedAt: 0,
  });
  const recordKey = record?.key ?? null;
  const recordingHash = record?.hash ?? null;
  const catalogId = record?.catalogId ?? null;
  const ownerUserId = record?.userId ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!recordKey) return;

    void (async () => {
      let bundle: DownloadBundlePayload | null = null;
      try {
        bundle = (await getDownloadBundle(recordKey)) ?? null;
      } catch {
        // The audio remains useful if IndexedDB cannot read the optional payload.
      } finally {
        if (!cancelled) setBundleState({ key: recordKey, bundle });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recordKey]);

  const persistPlaybackPosition = useCallback(
    (completed?: boolean) => {
      if (!recordingHash) return;
      const nextCompleted = completed ?? playbackRef.current.completed;
      playbackRef.current.completed = nextCompleted;
      if (nextCompleted) {
        markPlaybackCompleted(recordingHash);
      } else {
        savePlaybackPosition(recordingHash, playbackRef.current.time, {
          clearWhenZero: true,
        });
      }
      playbackRef.current.lastSavedAt = Date.now();
      if (catalogId && ownerUserId) {
        void queuePlaybackProgress({
          userId: ownerUserId,
          catalogId,
          hash: recordingHash,
          positionSec: nextCompleted
            ? playbackRef.current.duration || playbackRef.current.time
            : playbackRef.current.time,
          durationSec: playbackRef.current.duration || null,
          completed: nextCompleted,
        }).catch(() => {
          // LocalStorage still preserves resume state if IndexedDB is blocked.
        });
      }
    },
    [catalogId, ownerUserId, recordingHash],
  );

  useEffect(() => {
    if (!recordingHash) return;
    playbackRef.current = {
      time: getSavedPlaybackPosition(recordingHash) ?? 0,
      duration: 0,
      completed: isPlaybackCompleted(recordingHash),
      lastSavedAt: 0,
    };
    const persistWhenHidden = () => {
      if (document.visibilityState === 'hidden') persistPlaybackPosition();
    };
    const persistOnPageHide = () => persistPlaybackPosition();
    window.addEventListener('pagehide', persistOnPageHide);
    document.addEventListener('visibilitychange', persistWhenHidden);
    return () => {
      persistPlaybackPosition();
      window.removeEventListener('pagehide', persistOnPageHide);
      document.removeEventListener('visibilitychange', persistWhenHidden);
    };
  }, [persistPlaybackPosition, recordingHash]);

  const handleTimeUpdate = useCallback(
    (time: number) => {
      setCurrentTime(time);
      playbackRef.current.time = time;
      if (Date.now() - playbackRef.current.lastSavedAt >= 5_000) {
        persistPlaybackPosition();
      }
    },
    [persistPlaybackPosition],
  );

  const bundle = bundleState.key === record?.key ? bundleState.bundle : null;
  const loading = record !== null && bundleState.key !== record.key;

  const identity = useMemo(() => {
    if (!record) return null;
    const event = record.event;
    const recording = record.recording;
    const year = event?.dateYear ?? recording?.dateYear ?? null;
    const month = event?.dateMonth ?? recording?.dateMonth ?? null;
    const day = event?.dateDay ?? recording?.dateDay ?? null;
    const date =
      year === null
        ? null
        : (formatPartialDate(year, month, day, locale) ?? String(year));
    return {
      title: event?.title ?? recording?.title ?? t('unknownTitle'),
      subtitle: event
        ? [date, event.locationName].filter(Boolean).join(' · ')
        : [date, recording?.artist].filter(Boolean).join(' · '),
    };
  }, [locale, record, t]);

  const seek = (time: number) => {
    setCurrentTime(time);
    playbackRef.current.time = time;
    persistPlaybackPosition();
    setSeekTo(time);
    setSeekKey((value) => value + 1);
  };

  if (!record) {
    return (
      <OfflineDetailFrame onBack={onBack}>
        <div
          className="rounded-lg border p-8 text-center"
          data-testid="download-detail-missing"
        >
          <WifiOff
            className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="font-medium">{t('detailUnavailable')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('detailUnavailableDescription')}
          </p>
        </div>
      </OfflineDetailFrame>
    );
  }

  if (loading) {
    return (
      <OfflineDetailFrame onBack={onBack}>
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        </div>
      </OfflineDetailFrame>
    );
  }

  return (
    <OfflineDetailFrame onBack={onBack}>
      <article
        className="space-y-6"
        data-testid="download-detail"
        data-download-key={record.key}
      >
        {bundle?.poster && <OfflinePoster payload={bundle.poster} />}

        <header className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              {record.event ? t('eventLabel') : t('recordingLabel')}
            </Badge>
            <Badge variant="secondary">{t('availableOffline')}</Badge>
          </div>
          <h1 className="text-2xl font-semibold">{identity?.title}</h1>
          {identity?.subtitle && (
            <p className="text-sm text-muted-foreground">{identity.subtitle}</p>
          )}
        </header>

        {record.audioUrl ? (
          <section
            aria-label={t('offlinePlayer')}
            data-testid="download-detail-player"
          >
            <AudioPlayer
              src={record.audioUrl}
              catalogId={record.catalogId}
              onTimeUpdate={handleTimeUpdate}
              onPlayingChange={(isPlaying) => {
                if (!isPlaying) persistPlaybackPosition();
              }}
              onSeek={(time) => {
                playbackRef.current.time = time;
                setCurrentTime(time);
                persistPlaybackPosition();
              }}
              onDurationChange={(duration) => {
                playbackRef.current.duration = duration;
              }}
              onEnded={(duration) => {
                playbackRef.current.time = duration;
                playbackRef.current.duration = duration;
                persistPlaybackPosition(true);
              }}
              seekTo={seekTo}
              seekKey={seekKey}
              autoPlayOnSeek
            />
          </section>
        ) : (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {t('audioUnavailable')}
          </p>
        )}

        {bundle?.transcript ? (
          <section
            className="space-y-3"
            data-testid="download-detail-transcript"
          >
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4" aria-hidden="true" />
              <h2 className="font-medium">{t('transcript')}</h2>
              {bundle.transcriptBackend && (
                <Badge variant="outline">{bundle.transcriptBackend}</Badge>
              )}
            </div>
            <TranscriptContent
              transcript={bundle.transcript}
              diarization={bundle.diarization ?? undefined}
              currentTime={currentTime}
              onSeek={seek}
              autoScroll
              showTimestamps
            />
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('noOfflineTranscript')}
          </p>
        )}
      </article>
    </OfflineDetailFrame>
  );
}

function OfflinePoster({
  payload,
}: {
  payload: NonNullable<DownloadBundlePayload['poster']>;
}) {
  const posterUrl = useMemo(
    () => URL.createObjectURL(payload.blob),
    [payload.blob],
  );

  useEffect(() => () => URL.revokeObjectURL(posterUrl), [posterUrl]);

  return (
    // The poster is a device-local Blob URL, not a Next Image candidate.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={posterUrl}
      alt=""
      className="max-h-72 w-full rounded-lg object-contain bg-muted"
      data-testid="download-detail-poster"
    />
  );
}

function OfflineDetailFrame({
  children,
  onBack,
}: {
  children: React.ReactNode;
  onBack: () => void;
}) {
  const t = useTranslations('downloads');
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <CircularBackButton
        label={t('backToDownloads')}
        onClick={onBack}
        testId="downloads-back"
      />
      {children}
    </div>
  );
}
