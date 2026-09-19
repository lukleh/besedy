'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertCircle,
  Check,
  Download,
  HardDrive,
  Loader2,
  Pause,
  Play,
  Trash2,
  WifiOff,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useDownloadManager } from '@/hooks/use-downloads';
import { useInstallPrompt } from '@/hooks/use-install-prompt';
import { formatPartialDate } from '@/lib/date-format';
import { formatBytes } from '@/lib/format-bytes';
import {
  downloadManager,
  type DownloadRecord,
} from '@/lib/offline/download-manager';
import { cn } from '@/lib/utils';
import { CircularBackLink } from '@/components/navigation/circular-back-control';
import { OfflineDownloadDetail } from './download-detail';
import { SessionOrdinalBadge } from '@/components/catalog/session-ordinal-badge';

export function DownloadsContent() {
  const t = useTranslations('downloads');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const redirectedFrom = searchParams.get('from');
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    searchParams.get('item'),
  );
  const { records, supported, hydrated, storage, activeKey } =
    useDownloadManager();
  const { isInstalled } = useInstallPrompt();
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);

  useEffect(() => {
    const handlePopState = () => {
      setSelectedKey(new URL(window.location.href).searchParams.get('item'));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const setSelectedDownload = useCallback((key: string | null) => {
    const url = new URL(window.location.href);
    if (key) {
      url.searchParams.set('item', key);
    } else {
      url.searchParams.delete('item');
    }
    window.history.pushState({}, '', url);
    setSelectedKey(key);
  }, []);

  const selectedRecord = selectedKey
    ? (records.find((record) => record.key === selectedKey) ?? null)
    : null;

  const groups = useMemo(() => {
    const byCatalog = new Map<string, DownloadRecord[]>();
    for (const record of records) {
      const list = byCatalog.get(record.catalogId) ?? [];
      list.push(record);
      byCatalog.set(record.catalogId, list);
    }
    return Array.from(byCatalog.entries()).map(([catalogId, items]) => ({
      catalogId,
      catalogLabel:
        items.find((item) => item.catalogLabel)?.catalogLabel ?? null,
      items,
    }));
  }, [records]);

  const completeCount = records.filter(
    (record) => record.status === 'complete',
  ).length;
  const totalBytes = records.reduce(
    (sum, record) => sum + (record.totalBytes || 0),
    0,
  );

  if (selectedKey && hydrated) {
    return (
      <OfflineDownloadDetail
        record={selectedRecord}
        onBack={() => setSelectedDownload(null)}
      />
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      <header className="flex items-start gap-3">
        <CircularBackLink
          href="/catalog"
          label={t('backToCatalog')}
          className="mt-0.5"
          testId="downloads-catalog-back"
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Download className="h-6 w-6" aria-hidden="true" />
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
      </header>

      {redirectedFrom && (
        <div
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          role="status"
          data-testid="downloads-offline-redirect"
        >
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('offlineRedirect')}</span>
        </div>
      )}

      {hydrated && !supported && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('unsupported')}</span>
        </div>
      )}

      {supported && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <HardDrive className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span data-testid="downloads-storage">
              {storage && storage.quota > 0
                ? t('storageUsed', {
                    used: formatBytes(
                      Math.max(storage.usage, totalBytes),
                      locale,
                    ),
                    quota: formatBytes(storage.quota, locale),
                  })
                : t('storageUnknown')}
            </span>
          </div>
          {records.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemoveAll(true)}
              data-testid="downloads-remove-all"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t('removeAll')}
            </Button>
          )}
        </div>
      )}

      {supported && !isInstalled && completeCount > 0 && (
        <p className="text-xs text-muted-foreground">{t('installHint')}</p>
      )}

      {!hydrated ? (
        <div className="flex items-center gap-2 py-8 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : records.length === 0 ? (
        supported && (
          <div
            className="rounded-lg border p-8 text-center"
            data-testid="downloads-empty"
          >
            <Download
              className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="font-medium">{t('empty')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('emptyDescription')}
            </p>
          </div>
        )
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.catalogId} className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                {group.catalogLabel ??
                  t('unknownCatalog', { id: group.catalogId })}
              </h2>
              <div className="space-y-2">
                {group.items.map((record) => (
                  <DownloadCard
                    key={record.key}
                    record={record}
                    isActive={record.key === activeKey}
                    locale={locale}
                    onOpen={() => setSelectedDownload(record.key)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <AlertDialog open={confirmRemoveAll} onOpenChange={setConfirmRemoveAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('removeAllDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void downloadManager.removeAll();
              }}
            >
              {t('removeConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface DownloadCardProps {
  record: DownloadRecord;
  isActive: boolean;
  locale: string;
  onOpen: () => void;
}

function DownloadCard({ record, isActive, locale, onOpen }: DownloadCardProps) {
  const t = useTranslations('downloads');
  const event = record.event;
  const recording = record.recording;

  const dateYear = event?.dateYear ?? recording?.dateYear ?? null;
  const dateMonth = event?.dateMonth ?? recording?.dateMonth ?? null;
  const dateDay = event?.dateDay ?? recording?.dateDay ?? null;
  const formattedDate =
    dateYear !== null
      ? (formatPartialDate(dateYear, dateMonth, dateDay, locale) ??
        String(dateYear))
      : null;

  const title = event
    ? [formattedDate, event.locationName].filter(Boolean).join(' · ') ||
      event.title ||
      t('unknownTitle')
    : (recording?.title ?? t('unknownTitle'));
  const subtitle = event
    ? (event.title ?? recording?.title ?? null)
    : [formattedDate, recording?.artist].filter(Boolean).join(' · ') || null;

  const statusLabel = (() => {
    switch (record.status) {
      case 'queued':
        return t('statusQueued');
      case 'downloading':
        return t('statusDownloading', { progress: record.progress });
      case 'paused':
        return t('statusPaused');
      case 'error':
        return t('statusError');
      case 'complete':
        return t('statusComplete');
      default:
        return '';
    }
  })();

  const statusIcon = (() => {
    switch (record.status) {
      case 'queued':
        return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
      case 'downloading':
        return <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />;
      case 'paused':
        return <Pause className="h-4 w-4" aria-hidden="true" />;
      case 'error':
        return (
          <AlertCircle
            className="h-4 w-4 text-destructive"
            aria-hidden="true"
          />
        );
      case 'complete':
        return <Check className="h-4 w-4" aria-hidden="true" />;
      default:
        return null;
    }
  })();

  const sizeLabel =
    record.totalBytes > 0
      ? record.status === 'complete'
        ? formatBytes(record.totalBytes, locale)
        : `${formatBytes(record.bytesLoaded, locale)} / ${formatBytes(record.totalBytes, locale)}`
      : null;

  return (
    <Card
      data-testid={`download-card-${record.hash}`}
      data-status={record.status}
    >
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {event ? t('eventLabel') : t('recordingLabel')}
            </Badge>
            {event && (
              <SessionOrdinalBadge
                sessionOrdinal={event.sessionOrdinal}
                sessionCount={event.sessionCount}
              />
            )}
            {record.status === 'complete' && (
              <Badge variant="secondary">
                {record.transcriptBackend
                  ? t('withTranscript')
                  : t('audioOnly')}
              </Badge>
            )}
          </div>
          <p className="truncate font-medium">{title}</p>
          {subtitle && (
            <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {statusIcon}
              {statusLabel}
            </span>
            {recording?.recorderName && <span>{recording.recorderName}</span>}
            {recording?.durationHms && <span>{recording.durationHms}</span>}
            {sizeLabel && <span>{sizeLabel}</span>}
            {record.error && (
              <span className="text-destructive">{record.error}</span>
            )}
          </div>
          {(record.status === 'downloading' ||
            record.status === 'paused' ||
            record.status === 'queued') && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              aria-hidden="true"
            >
              <div
                className={cn(
                  'h-full rounded-full bg-muted-foreground/60 transition-all duration-300',
                  isActive && 'bg-primary',
                )}
                style={{ width: `${record.progress}%` }}
              />
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {record.status === 'complete' && (
            <Button size="sm" variant="default" onClick={onOpen}>
              <Play className="mr-2 h-4 w-4" />
              {t('open')}
            </Button>
          )}
          {(record.status === 'downloading' || record.status === 'queued') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void downloadManager.pause(record.key);
              }}
            >
              <Pause className="mr-2 h-4 w-4" />
              {t('pause')}
            </Button>
          )}
          {record.status === 'paused' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void downloadManager.resume(record.key);
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              {t('resume')}
            </Button>
          )}
          {record.status === 'error' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void downloadManager.resume(record.key);
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              {t('retry')}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={t('remove')}
            title={t('remove')}
            onClick={() => {
              void downloadManager.remove(record.key);
            }}
            data-testid={`download-remove-${record.hash}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
