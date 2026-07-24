'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Copy, Loader2, Plus, Search, Share2, Timer } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { fetchJson } from '@/lib/api/fetch-json';
import {
  deepSearchJobsListSchema,
  type DeepSearchJob,
  type DeepSearchJobsList,
} from '@/lib/jobs-api/schemas';
import {
  getDeepSearchJobDraft,
  type DeepSearchJobDraft,
} from './deep-search-job-draft';
import { DeepSearchNewJobDialog } from './deep-search-new-job-dialog';
import { DeepSearchShareDialog } from './deep-search-share-dialog';
import {
  DeepSearchStatusBadge,
  isActiveDeepSearchStatus,
} from './deep-search-status-badge';
import {
  formatJobDate,
  formatJobDuration,
  formatJobRelativeDate,
} from './deep-search-format';

interface DeepSearchListClientProps {
  catalogId: string;
  catalogLabel: string;
  canCreateJobs: boolean;
  deepSearchDefaultInstructions: string;
}

export function DeepSearchListClient({
  catalogId,
  catalogLabel,
  canCreateJobs,
  deepSearchDefaultInstructions,
}: DeepSearchListClientProps) {
  const locale = useLocale();
  const t = useTranslations('catalog');
  const unavailableLabel = t('deepSearch.fallback.notAvailable');
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDraft, setDialogDraft] = useState<DeepSearchJobDraft | null>(
    null,
  );
  const [activeScope, setActiveScope] = useState<'mine' | 'shared'>(
    canCreateJobs ? 'mine' : 'shared',
  );
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareDialogJob, setShareDialogJob] = useState<DeepSearchJob | null>(
    null,
  );

  const jobsQuery = useQuery<DeepSearchJobsList>({
    queryKey: ['deep-search-jobs', catalogId, activeScope],
    queryFn: () =>
      fetchJson<DeepSearchJobsList>(
        `/api/catalogs/${catalogId}/deep-search/jobs?scope=${activeScope}`,
        { schema: deepSearchJobsListSchema },
      ),
    refetchInterval: (query) => {
      const data = query.state.data as DeepSearchJobsList | undefined;
      return data?.jobs.some((job) => isActiveDeepSearchStatus(job.status))
        ? 5000
        : false;
    },
  });

  const jobs = useMemo(() => {
    return [...(jobsQuery.data?.jobs ?? [])].sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? '');
      const rightTime = Date.parse(right.created_at ?? '');
      return (
        (Number.isNaN(rightTime) ? 0 : rightTime) -
        (Number.isNaN(leftTime) ? 0 : leftTime)
      );
    });
  }, [jobsQuery.data?.jobs]);

  function openBlankJob() {
    if (!canCreateJobs) {
      return;
    }
    setDialogDraft(null);
    setDialogOpen(true);
  }

  function openFromJob(job: DeepSearchJob) {
    if (!canCreateJobs) {
      return;
    }
    setDialogDraft(getDeepSearchJobDraft(job));
    setDialogOpen(true);
  }

  function openShareDialog(job: DeepSearchJob) {
    setShareDialogJob(job);
    setShareDialogOpen(true);
  }

  const emptyTitle =
    activeScope === 'shared'
      ? t('deepSearch.list.sharedEmptyTitle')
      : t('deepSearch.list.emptyTitle');
  const emptyDescription =
    activeScope === 'shared'
      ? t('deepSearch.list.sharedEmptyDescription')
      : canCreateJobs
        ? t('deepSearch.list.emptyDescription')
        : t('deepSearch.list.mineReadOnlyEmptyDescription');

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href={`/catalog/${catalogId}`}>
              <ArrowLeft className="h-4 w-4" />
              {t('title')}
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">
              {t('deepSearch.label')}
            </h1>
          </div>
        </div>
        {canCreateJobs ? (
          <Button onClick={openBlankJob}>
            <Plus className="h-4 w-4" />
            {t('deepSearch.actions.newJob')}
          </Button>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label={t('deepSearch.list.tabs.ariaLabel')}
        className="flex items-center gap-2"
      >
        <Button
          role="tab"
          aria-selected={activeScope === 'mine'}
          variant={activeScope === 'mine' ? 'default' : 'outline'}
          onClick={() => setActiveScope('mine')}
        >
          {t('deepSearch.list.tabs.mine')}
        </Button>
        <Button
          role="tab"
          aria-selected={activeScope === 'shared'}
          variant={activeScope === 'shared' ? 'default' : 'outline'}
          onClick={() => setActiveScope('shared')}
        >
          {t('deepSearch.list.tabs.shared')}
        </Button>
      </div>

      {jobsQuery.isPending ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('deepSearch.list.loading')}
        </div>
      ) : jobsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('deepSearch.list.loadErrorTitle')}</AlertTitle>
          <AlertDescription>
            {jobsQuery.error instanceof Error
              ? jobsQuery.error.message
              : t('deepSearch.fallback.requestFailed')}
          </AlertDescription>
        </Alert>
      ) : jobs.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center">
          <Search className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-semibold">
            {emptyTitle}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {emptyDescription}
          </p>
          {canCreateJobs && activeScope === 'mine' ? (
            <Button className="mt-5" onClick={openBlankJob}>
              <Plus className="h-4 w-4" />
              {t('deepSearch.actions.newJob')}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <div className="hidden rounded-lg border md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('deepSearch.list.columns.query')}</TableHead>
                  <TableHead>{t('deepSearch.list.columns.status')}</TableHead>
                  <TableHead>{t('deepSearch.list.columns.created')}</TableHead>
                  <TableHead>{t('deepSearch.list.columns.duration')}</TableHead>
                  <TableHead className="text-right">
                    {t('deepSearch.list.columns.actions')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow
                    key={job.id}
                    role="link"
                    tabIndex={0}
                    className="cursor-pointer"
                    onClick={() =>
                      router.push(`/catalog/${catalogId}/deep-search/${job.id}`)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        router.push(
                          `/catalog/${catalogId}/deep-search/${job.id}`,
                        );
                      }
                    }}
                  >
                    <TableCell className="max-w-[28rem]">
                      <div className="truncate font-medium">
                        {job.payload.query ||
                          t('deepSearch.fallback.untitledQuery')}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {job.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DeepSearchStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell>
                      <div>
                        {formatJobDate(
                          job.created_at,
                          locale,
                          unavailableLabel,
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatJobRelativeDate(
                          job.created_at,
                          locale,
                          unavailableLabel,
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="inline-flex items-center gap-1 text-sm">
                        <Timer className="h-3.5 w-3.5 text-muted-foreground" />
                        {formatJobDuration(
                          job.started_at ?? job.created_at,
                          job.finished_at,
                          unavailableLabel,
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {job.access !== 'shared' ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('deepSearch.share.openDialog')}
                            title={t('deepSearch.share.openDialog')}
                            onClick={(event) => {
                              event.stopPropagation();
                              openShareDialog(job);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Share2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                        {canCreateJobs ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation();
                              openFromJob(job);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                          >
                            <Copy className="h-4 w-4" />
                            {t('deepSearch.actions.newFromInputs')}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-3 md:hidden">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-lg border bg-card p-4">
                <Link
                  href={`/catalog/${catalogId}/deep-search/${job.id}`}
                  className="block"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="line-clamp-2 font-medium">
                        {job.payload.query ||
                          t('deepSearch.fallback.untitledQuery')}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        {formatJobRelativeDate(
                          job.created_at,
                          locale,
                          unavailableLabel,
                        )}
                      </div>
                    </div>
                    <DeepSearchStatusBadge status={job.status} />
                  </div>
                </Link>
                <div className="mt-3 flex gap-2">
                  {job.access !== 'shared' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => openShareDialog(job)}
                    >
                      <Share2 className="h-4 w-4" />
                      {t('deepSearch.share.openDialogShort')}
                    </Button>
                  ) : null}
                  {canCreateJobs ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => openFromJob(job)}
                    >
                      <Copy className="h-4 w-4" />
                      {t('deepSearch.actions.newFromInputs')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {canCreateJobs ? (
        <DeepSearchNewJobDialog
          catalogId={catalogId}
          catalogLabel={catalogLabel}
          deepSearchDefaultInstructions={deepSearchDefaultInstructions}
          draft={dialogDraft}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}
      <DeepSearchShareDialog
        catalogId={catalogId}
        job={shareDialogJob}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />
    </div>
  );
}
