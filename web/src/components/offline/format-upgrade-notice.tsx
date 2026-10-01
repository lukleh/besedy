'use client';

import { useTranslations } from 'next-intl';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadManager } from '@/lib/offline/download-manager';

/**
 * Shown where a WebM download made before the AAC copy existed (#291) plays
 * on WebKit, which stops it at Safari's first capped response; see
 * `useAacUpgradeAvailable`. Downloading again replaces it with the copy.
 */
export function FormatUpgradeNotice({ downloadKey }: { downloadKey: string }) {
  const t = useTranslations('downloads');
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
      data-testid="format-upgrade-notice"
    >
      <span className="min-w-0 flex-1">{t('formatUpgrade')}</span>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void downloadManager.redownload(downloadKey);
        }}
      >
        <Download className="mr-2 h-4 w-4" />
        {t('redownload')}
      </Button>
    </div>
  );
}
