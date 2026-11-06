'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { fetchJson } from '@/lib/api/fetch-json';
import { formatLocalDate } from '@/lib/date-format';
import { AUTH_SENSITIVE_QUERY_OPTIONS } from '@/lib/query/auth-sensitive';
import { catalogSyncStatusResponseSchema } from '@/lib/catalog-sync/status';

/** Mounted only for system admins; the endpoint independently enforces that. */
export function CatalogSettingsSyncStatus({
  catalogId,
}: {
  catalogId: string;
}) {
  const t = useTranslations('catalogSettings.syncStatus');
  const locale = useLocale();
  const query = useQuery({
    queryKey: ['catalog-sync-status', catalogId],
    queryFn: () =>
      fetchJson(
        `/api/admin/catalog-sync?groupId=${encodeURIComponent(catalogId)}`,
        {
          schema: catalogSyncStatusResponseSchema,
        },
      ),
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  if (query.error)
    return (
      <p className="text-sm text-destructive" role="alert">
        {t('loadError')}
      </p>
    );
  if (!query.data)
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  return (
    <div className="mb-4 space-y-3 text-sm" aria-label={t('title')}>
      {query.data.sources.length === 0 ? (
        <p>{t('notRun')}</p>
      ) : (
        query.data.sources.map((source) => (
          <div key={source.sourceKey}>
            <p className="font-medium">
              {t(source.sourceKey)}: {t(source.status)}
            </p>
            <p className="text-muted-foreground">
              {t('lastSuccess')}:{' '}
              {source.lastSuccessfulAt ? (
                <time dateTime={source.lastSuccessfulAt}>
                  {formatLocalDate(source.lastSuccessfulAt, locale, 'PPp')}
                </time>
              ) : (
                t('unknown')
              )}
            </p>
            {source.status === 'ERROR' && source.lastError && (
              <p className="whitespace-pre-wrap break-words text-destructive">
                {source.lastError}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}
