'use client';

/**
 * Local-mode bootstrap.
 *
 * The service worker answers a failed navigation with the cached, session-free
 * `/downloads` document at the requested URL. This component reads that URL
 * and renders the shared presentation for it from local download packages:
 * the Downloads library, a catalog's downloaded events, or the normal event or
 * recording page. Navigation between these pages is ordinary: a Next.js link
 * whose data fetch fails becomes a full navigation, which the worker answers
 * with this document again.
 *
 * The shared pages are imported statically so their chunks belong to this
 * document and are cached by the same warm-up that caches the shell itself.
 */
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, WifiOff } from 'lucide-react';
import RecordingContent from '@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content';
import { EventDetail } from '@/components/catalog/event-detail';
import { Button } from '@/components/ui/button';
import { useIsHydrated } from '@/hooks/use-is-hydrated';
import { DOWNLOADS_PATH } from '@/lib/offline/cache-names';
import { DownloadsContent } from './downloads-content';
import { LocalEventList } from './local-event-list';

type LocalRoute =
  | { kind: 'downloads' }
  | { kind: 'catalog'; catalogId: string }
  | { kind: 'event'; catalogId: string; eventId: number }
  | { kind: 'recording'; catalogId: string; hash: string }
  | { kind: 'unavailable' };

const RECORDING_HASH = /^[a-f0-9]{64}$/;

export function resolveLocalRoute(pathname: string): LocalRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0 || pathname === DOWNLOADS_PATH) {
    return { kind: 'downloads' };
  }
  if (segments[0] !== 'catalog') return { kind: 'unavailable' };
  if (segments.length === 1) return { kind: 'downloads' };
  const catalogId = decodeURIComponent(segments[1]);
  if (segments.length === 2) return { kind: 'catalog', catalogId };
  if (segments.length === 4 && segments[2] === 'event') {
    const eventId = Number(segments[3]);
    if (Number.isSafeInteger(eventId) && eventId > 0) {
      return { kind: 'event', catalogId, eventId };
    }
  }
  if (segments.length === 4 && segments[2] === 'recording') {
    const hash = segments[3].toLowerCase();
    if (RECORDING_HASH.test(hash)) return { kind: 'recording', catalogId, hash };
  }
  return { kind: 'unavailable' };
}

/**
 * A worker from before the URL-preserving shell answers a failed navigation
 * with a redirect to `/downloads?from=<original>`. Until that worker is
 * replaced, honour the original URL so the person still reaches the page they
 * asked for.
 */
function redirectedFromPath(from: string | null): string | null {
  if (!from || !from.startsWith('/') || from.startsWith('//')) return null;
  return from.split('?')[0];
}

export function LocalModeShell() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hydrated = useIsHydrated();
  const redirectedFrom =
    pathname === DOWNLOADS_PATH
      ? redirectedFromPath(searchParams.get('from'))
      : null;
  const effectivePath = redirectedFrom ?? pathname ?? DOWNLOADS_PATH;

  useEffect(() => {
    if (!hydrated || !redirectedFrom) return;
    // Show the URL the person asked for; no navigation is involved.
    window.history.replaceState(window.history.state, '', redirectedFrom);
  }, [hydrated, redirectedFrom]);

  // The server renders this document for /downloads. The URL it is replayed
  // at is only known on the client, so route after hydration to keep the
  // server and client trees identical.
  if (!hydrated) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
      </div>
    );
  }

  const route = resolveLocalRoute(effectivePath);
  switch (route.kind) {
    case 'downloads':
      return <DownloadsContent />;
    case 'catalog':
      return <LocalEventList catalogId={route.catalogId} />;
    case 'event':
      return (
        <EventDetail
          catalogId={route.catalogId}
          eventId={route.eventId}
          canEdit={false}
          showAllColumns={false}
          showReleaseState={false}
        />
      );
    case 'recording':
      return (
        <RecordingContent
          params={{ catalogId: route.catalogId, hash: route.hash }}
          skipCatalogValidation
        />
      );
    default:
      return <OfflineUnavailable />;
  }
}

function OfflineUnavailable() {
  const t = useTranslations('downloads');
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 lg:px-8">
      <div
        className="rounded-lg border p-8 text-center"
        data-testid="offline-unavailable"
      >
        <WifiOff
          className="mx-auto mb-3 h-10 w-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h1 className="font-medium">{t('unavailableOffline')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('unavailableOfflineDescription')}
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link href={DOWNLOADS_PATH}>{t('title')}</Link>
        </Button>
      </div>
    </div>
  );
}
