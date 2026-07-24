'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  Copy,
  FileDown,
  Loader2,
  RefreshCw,
  Share2,
} from 'lucide-react';
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
import { copyToClipboard } from '@/lib/clipboard';
import { normalizeDeepSearchResultMarkdown } from '@/lib/deep-search/result-markdown';
import {
  deepSearchJobHistorySchema,
  deepSearchJobSchema,
  type DeepSearchJob,
  type DeepSearchJobHistory,
} from '@/lib/jobs-api/schemas';
import { useToast } from '@/hooks/use-toast';
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
  stringifyJson,
} from './deep-search-format';

interface DeepSearchDetailClientProps {
  catalogId: string;
  catalogLabel: string;
  jobId: string;
  canCreateJobs: boolean;
  deepSearchDefaultInstructions: string;
}

export function DeepSearchDetailClient({
  catalogId,
  catalogLabel,
  jobId,
  canCreateJobs,
  deepSearchDefaultInstructions,
}: DeepSearchDetailClientProps) {
  const locale = useLocale();
  const t = useTranslations('catalog');
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDraft, setDialogDraft] = useState<DeepSearchJobDraft | null>(
    null,
  );
  const [shareDialogOpen, setShareDialogOpen] = useState(false);

  const jobQuery = useQuery<DeepSearchJob>({
    queryKey: ['deep-search-job', catalogId, jobId],
    queryFn: () =>
      fetchJson<DeepSearchJob>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}`,
        { schema: deepSearchJobSchema },
      ),
    refetchInterval: (query) => {
      const data = query.state.data as DeepSearchJob | undefined;
      return data && isActiveDeepSearchStatus(data.status) ? 5000 : false;
    },
  });

  const historyQuery = useQuery<DeepSearchJobHistory>({
    queryKey: ['deep-search-job-history', catalogId, jobId],
    queryFn: () =>
      fetchJson<DeepSearchJobHistory>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/history`,
        { schema: deepSearchJobHistorySchema },
      ),
    enabled: jobQuery.isSuccess,
    refetchInterval: () =>
      jobQuery.data && isActiveDeepSearchStatus(jobQuery.data.status)
        ? 5000
        : false,
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      fetchJson<DeepSearchJob>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/cancel`,
        {
          method: 'POST',
          schema: deepSearchJobSchema,
        },
      ),
    onSuccess: (job) => {
      queryClient.setQueryData(['deep-search-job', catalogId, jobId], job);
      queryClient.invalidateQueries({
        queryKey: ['deep-search-job-history', catalogId, jobId],
      });
      queryClient.invalidateQueries({
        queryKey: ['deep-search-jobs', catalogId],
      });
    },
  });

  const job = jobQuery.data;
  const isSharedJob = job?.access === 'shared';
  const canCancel = job ? !isSharedJob && isActiveDeepSearchStatus(job.status) : false;

  function openNewJobFromCurrentInputs(jobToCopy: DeepSearchJob) {
    if (!canCreateJobs) {
      return;
    }
    setDialogDraft(getDeepSearchJobDraft(jobToCopy));
    setDialogOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href={`/catalog/${catalogId}/deep-search`}>
              <ArrowLeft className="h-4 w-4" />
              {t('deepSearch.label')}
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">
              {job?.payload.query || t('deepSearch.jobFallback')}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {job ? <DeepSearchStatusBadge status={job.status} /> : null}
          {job && !isSharedJob ? (
            <Button
              variant="outline"
              onClick={() => setShareDialogOpen(true)}
            >
              <Share2 className="h-4 w-4" />
              {t('deepSearch.share.openDialogShort')}
            </Button>
          ) : null}
          {job && canCreateJobs ? (
            <Button
              variant="outline"
              onClick={() => openNewJobFromCurrentInputs(job)}
            >
              <Copy className="h-4 w-4" />
              {t('deepSearch.actions.newFromInputs')}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="outline"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Ban className="h-4 w-4" />
              )}
              {t('deepSearch.actions.cancel')}
            </Button>
          ) : null}
        </div>
      </div>

      {jobQuery.isPending ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('deepSearch.detail.loading')}
        </div>
      ) : jobQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t('deepSearch.detail.loadErrorTitle')}</AlertTitle>
          <AlertDescription>
            {jobQuery.error instanceof Error
              ? jobQuery.error.message
              : t('deepSearch.fallback.requestFailed')}
          </AlertDescription>
        </Alert>
      ) : job ? (
        <>
          {cancelMutation.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{t('deepSearch.detail.cancelErrorTitle')}</AlertTitle>
              <AlertDescription>
                {cancelMutation.error instanceof Error
                  ? cancelMutation.error.message
                  : t('deepSearch.fallback.requestFailed')}
              </AlertDescription>
            </Alert>
          ) : null}
          <JobOverviewSection
            catalogId={catalogId}
            job={job}
            lastUpdatedAt={jobQuery.dataUpdatedAt}
          />
          <TechnicalDetailsSection
            job={job}
            catalogId={catalogId}
            catalogLabel={catalogLabel}
            history={historyQuery.data}
            historyLoading={historyQuery.isPending}
            locale={locale}
          />
        </>
      ) : null}
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
        job={job ?? null}
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
      />
    </div>
  );
}

function JobOverviewSection({
  catalogId,
  job,
  lastUpdatedAt,
}: {
  catalogId: string;
  job: DeepSearchJob;
  lastUpdatedAt: number;
}) {
  const t = useTranslations('catalog');
  const { toast } = useToast();
  const unavailableLabel = t('deepSearch.fallback.notAvailable');
  const result = asRecord(job.result);
  const markdown =
    result && typeof result.markdown === 'string' ? result.markdown : '';
  const active = isActiveDeepSearchStatus(job.status);
  const metrics = getRlmProgressMetrics(job);
  const lastUpdatedSeconds = useSecondsSince(lastUpdatedAt, active);
  const [copySuccess, setCopySuccess] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const pdfHref = `/api/catalogs/${encodeURIComponent(catalogId)}/deep-search/jobs/${encodeURIComponent(job.id)}/result.pdf`;
  const statusLabels: Record<DeepSearchJob['status'], string> = {
    QUEUED: t('deepSearch.status.queued'),
    RUNNING: t('deepSearch.status.running'),
    SUCCEEDED: t('deepSearch.status.succeeded'),
    FAILED: t('deepSearch.status.failed'),
    CANCELLED: t('deepSearch.status.cancelled'),
  };

  const handleCopyResult = useCallback(async () => {
    if (!markdown) {
      return;
    }

    try {
      await copyToClipboard(markdown);
      setCopySuccess(true);
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current);
      }
      copyResetRef.current = window.setTimeout(() => {
        setCopySuccess(false);
      }, 2000);
    } catch {
      setCopySuccess(false);
      toast({
        title: t('deepSearch.detail.copyResultError'),
        variant: 'destructive',
      });
    }
  }, [markdown, t, toast]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        window.clearTimeout(copyResetRef.current);
      }
    };
  }, []);

  return (
    <section className="space-y-5 rounded-lg border bg-card p-5">
      <div className="grid gap-4">
        <Field
          label={t('deepSearch.fields.query')}
          value={job.payload.query || unavailableLabel}
          wide
        />
        <Field
          label={t('deepSearch.fields.instructions')}
          value={job.payload.instructions || unavailableLabel}
          wide
          multiline
        />
      </div>

      <div className="space-y-4 border-t pt-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">
            {active
              ? t('deepSearch.detail.progressTitle')
              : t('deepSearch.detail.resultsTitle')}
          </h2>
          {!active && markdown ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label={t('deepSearch.detail.downloadResultPdf')}
                title={t('deepSearch.detail.downloadResultPdf')}
                asChild
              >
                <a href={pdfHref} target="_blank" rel="noreferrer">
                  <FileDown className="h-4 w-4" />
                </a>
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={
                  copySuccess
                    ? t('deepSearch.detail.copyResultSuccess')
                    : t('deepSearch.detail.copyResult')
                }
                title={
                  copySuccess
                    ? t('deepSearch.detail.copyResultSuccess')
                    : t('deepSearch.detail.copyResult')
                }
                className={
                  copySuccess
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                    : undefined
                }
                onClick={handleCopyResult}
              >
                {copySuccess ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          ) : null}
        </div>

        {active ? (
          <RunningProgressPanel
            key={lastUpdatedAt}
            metrics={metrics}
            fallbackLabel={unavailableLabel}
            statusLabel={statusLabels[job.status] || unavailableLabel}
            lastUpdatedSeconds={lastUpdatedSeconds}
          />
        ) : markdown ? (
          <MarkdownResult markdown={markdown} />
        ) : job.status === 'FAILED' && !result ? (
          <Alert variant="destructive">
            <AlertTitle>{t('deepSearch.detail.noResultTitle')}</AlertTitle>
            <AlertDescription>
              {t('deepSearch.detail.noResultDescription')}
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('deepSearch.detail.noMarkdown')}
          </p>
        )}
      </div>
    </section>
  );
}

function RunningProgressPanel({
  metrics,
  fallbackLabel,
  statusLabel,
  lastUpdatedSeconds,
}: {
  metrics: RlmProgressMetrics;
  fallbackLabel: string;
  statusLabel: string;
  lastUpdatedSeconds: number;
}) {
  const t = useTranslations('catalog');

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
          {statusLabel}
        </div>
        <div className="text-xs text-muted-foreground">
          {t('deepSearch.detail.lastUpdatedSecondsAgo', {
            seconds: lastUpdatedSeconds,
          })}
        </div>
      </div>
      <ProgressMetrics metrics={metrics} fallbackLabel={fallbackLabel} />
    </div>
  );
}

function MarkdownResult({ markdown }: { markdown: string }) {
  return (
    <div className="max-h-[36rem] overflow-auto rounded-md border bg-muted/40 p-4 text-sm leading-7">
      <MarkdownContent markdown={markdown} />
    </div>
  );
}

function MarkdownContent({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h1 className="mb-3 text-xl font-semibold">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="mt-6 mb-2 text-lg font-semibold">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="mt-5 mb-2 text-base font-semibold">{children}</h3>
        ),
        p: ({ children }) => <p className="my-3">{children}</p>,
        ul: ({ children }) => (
          <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>
        ),
        li: ({ children }) => <li>{children}</li>,
        blockquote: ({ children }) => (
          <blockquote className="my-4 border-l-2 pl-4 text-muted-foreground">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline underline-offset-2"
          >
            {children}
          </a>
        ),
        code: ({ className, children }) => (
          <code
            className={
              className
                ? `${className} text-xs`
                : 'rounded bg-muted px-1 py-0.5 font-mono text-xs'
            }
          >
            {children}
          </code>
        ),
        pre: ({ children }) => (
          <pre className="my-4 overflow-auto rounded-md bg-background p-3 text-xs">
            {children}
          </pre>
        ),
        table: ({ children }) => (
          <div className="my-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border px-2 py-1 font-semibold">{children}</th>
        ),
        td: ({ children }) => (
          <td className="border px-2 py-1 align-top">{children}</td>
        ),
      }}
    >
      {normalizeDeepSearchResultMarkdown(markdown)}
    </ReactMarkdown>
  );
}

function TechnicalDetailsSection({
  job,
  catalogId,
  catalogLabel,
  history,
  historyLoading,
  locale,
}: {
  job: DeepSearchJob;
  catalogId: string;
  catalogLabel: string;
  history: DeepSearchJobHistory | undefined;
  historyLoading: boolean;
  locale: string;
}) {
  const t = useTranslations('catalog');
  const tCommon = useTranslations('common');
  const unavailableLabel = t('deepSearch.fallback.notAvailable');
  const pendingRuntimeLabel = t('deepSearch.fallback.pendingRuntime');
  const runtimeConfig = getEffectiveDeepSearchConfig(job);
  const metrics = getRlmProgressMetrics(job);
  const unresolvedRuntimeLabel = runtimeConfig.hasResolvedConfig
    ? unavailableLabel
    : job.status === 'QUEUED' || job.status === 'RUNNING'
      ? pendingRuntimeLabel
      : unavailableLabel;
  const statusLabels: Record<DeepSearchJob['status'], string> = {
    QUEUED: t('deepSearch.status.queued'),
    RUNNING: t('deepSearch.status.running'),
    SUCCEEDED: t('deepSearch.status.succeeded'),
    FAILED: t('deepSearch.status.failed'),
    CANCELLED: t('deepSearch.status.cancelled'),
  };
  const retrievalRows: ConfigRow[] = [
    {
      label: t('deepSearch.fields.topK'),
      value: runtimeConfig.retrieval.topK ?? unavailableLabel,
    },
    {
      label: t('deepSearch.fields.includeNeighbors'),
      value: formatOptionalBoolean(
        runtimeConfig.retrieval.includeNeighbors,
        tCommon('yes'),
        tCommon('no'),
        unavailableLabel,
      ),
    },
    {
      label: t('deepSearch.fields.neighborCount'),
      value: runtimeConfig.retrieval.neighborCount ?? unavailableLabel,
    },
    {
      label: t('deepSearch.fields.windowNeighborCount'),
      value: runtimeConfig.retrieval.windowNeighborCount ?? unavailableLabel,
    },
  ];
  const executionRows: ConfigRow[] = [
    {
      label: t('deepSearch.fields.executionMode'),
      value: runtimeConfig.execution.mode ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.executor'),
      value: runtimeConfig.execution.executor ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.workload'),
      value: runtimeConfig.execution.workload ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.adapterMode'),
      value: runtimeConfig.execution.adapterMode ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.replBackend'),
      value: runtimeConfig.execution.replBackend ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.seed'),
      value: runtimeConfig.execution.seed ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.lmProfile'),
      value: runtimeConfig.execution.lmProfile ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.lmModel'),
      value: runtimeConfig.execution.lmModel ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.subLmProfile'),
      value: runtimeConfig.execution.subLmProfile ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.subLmModel'),
      value: runtimeConfig.execution.subLmModel ?? unresolvedRuntimeLabel,
    },
    {
      label: t('deepSearch.fields.logDir'),
      value: runtimeConfig.execution.logDir ?? unresolvedRuntimeLabel,
      mono: true,
    },
  ];

  return (
    <details className="rounded-lg border bg-card p-5">
      <summary className="cursor-pointer text-lg font-semibold">
        {t('deepSearch.detail.technicalDetails')}
      </summary>
      <p className="mt-2 text-sm text-muted-foreground">
        {t('deepSearch.detail.technicalDetailsDescription')}
      </p>

      <div className="mt-5 space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label={t('deepSearch.fields.catalog')}
            value={`${catalogLabel} (${catalogId})`}
          />
          <Field label={t('deepSearch.fields.jobId')} value={job.id} mono />
          <Field
            label={t('deepSearch.fields.status')}
            value={statusLabels[job.status] ?? job.status}
          />
          <Field
            label={t('deepSearch.fields.prefectState')}
            value={job.prefectStateName || unavailableLabel}
          />
          <Field
            label={t('deepSearch.fields.stateType')}
            value={job.prefectStateType || unavailableLabel}
          />
          <Field
            label={t('deepSearch.fields.duration')}
            value={formatJobDuration(
              job.started_at ?? job.created_at,
              job.finished_at,
              unavailableLabel,
            )}
          />
          <Field
            label={t('deepSearch.fields.created')}
            value={formatJobDate(job.created_at, locale, unavailableLabel)}
          />
          <Field
            label={t('deepSearch.fields.started')}
            value={formatJobDate(job.started_at, locale, unavailableLabel)}
          />
          <Field
            label={t('deepSearch.fields.finished')}
            value={formatJobDate(job.finished_at, locale, unavailableLabel)}
          />
          <Field
            label={t('deepSearch.fields.updated')}
            value={formatJobDate(job.updated_at, locale, unavailableLabel)}
          />
        </div>

        <div className="border-t pt-5">
          <h3 className="mb-3 text-sm font-semibold">
            {t('deepSearch.detail.progressTitle')}
          </h3>
          <ProgressMetrics metrics={metrics} fallbackLabel={unavailableLabel} />
        </div>

        <div className="grid gap-6 border-t pt-5 md:grid-cols-2">
          <ConfigGroup
            title={t('deepSearch.fields.retrieval')}
            rows={retrievalRows}
          />
          <ConfigGroup
            title={t('deepSearch.fields.execution')}
            rows={executionRows}
          />
        </div>

        {job.error_message ? (
          <Alert variant={job.status === 'FAILED' ? 'destructive' : 'default'}>
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t('deepSearch.detail.stateMessage')}</AlertTitle>
            <AlertDescription>{job.error_message}</AlertDescription>
          </Alert>
        ) : null}

        <HistoryDetails
          history={history}
          historyLoading={historyLoading}
          locale={locale}
        />

        <div className="grid gap-4 border-t pt-5 md:grid-cols-2">
          <JsonBlock
            title={t('deepSearch.detail.submittedRetrieval')}
            value={job.payload.retrieval ?? {}}
          />
          <JsonBlock
            title={t('deepSearch.detail.submittedExecution')}
            value={job.payload.execution ?? {}}
          />
        </div>

        {job.result ? <TechnicalResultDetails result={job.result} /> : null}
      </div>
    </details>
  );
}

function ProgressMetrics({
  metrics,
  fallbackLabel,
}: {
  metrics: RlmProgressMetrics;
  fallbackLabel: string;
}) {
  const t = useTranslations('catalog');
  const optionalMetrics = [
    {
      label: t('deepSearch.fields.searchCalls'),
      value: metrics.searchCalls,
    },
    {
      label: t('deepSearch.fields.windowCalls'),
      value: metrics.windowCalls,
    },
    {
      label: t('deepSearch.fields.uniqueChunks'),
      value: metrics.uniqueChunks,
    },
    {
      label: t('deepSearch.fields.uniqueAudioHashes'),
      value: metrics.uniqueAudioHashes,
    },
    {
      label: t('deepSearch.fields.retrievedContextChars'),
      value: metrics.retrievedContextChars,
    },
  ].filter((item) => item.value !== null);

  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <MetricValue
        label={t('deepSearch.fields.rlmSteps')}
        value={metrics.steps ?? fallbackLabel}
      />
      <MetricValue
        label={t('deepSearch.fields.toolCalls')}
        value={metrics.toolCalls ?? fallbackLabel}
      />
      <MetricValue
        label={t('deepSearch.fields.subLlmCalls')}
        value={metrics.subLlmCalls ?? fallbackLabel}
      />
      {optionalMetrics.map((item) => (
        <MetricValue
          key={item.label}
          label={item.label}
          value={item.value ?? fallbackLabel}
        />
      ))}
    </dl>
  );
}

function MetricValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l pl-3">
      <dt className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}

function useSecondsSince(timestampMs: number, enabled: boolean) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - timestampMs) / 1000)),
      );
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [enabled, timestampMs]);

  if (!enabled || !timestampMs) {
    return 0;
  }

  return elapsedSeconds;
}

function HistoryDetails({
  history,
  historyLoading,
  locale,
}: {
  history: DeepSearchJobHistory | undefined;
  historyLoading: boolean;
  locale: string;
}) {
  const t = useTranslations('catalog');
  const unavailableLabel = t('deepSearch.fallback.notAvailable');

  return (
    <div className="border-t pt-5">
      <h3 className="mb-2 text-sm font-semibold">
        {t('deepSearch.detail.historyTitle')}
      </h3>
      {historyLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('deepSearch.detail.loadingHistory')}
        </div>
      ) : history?.events.length ? (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('deepSearch.fields.state')}</TableHead>
                <TableHead>{t('deepSearch.fields.message')}</TableHead>
                <TableHead>{t('deepSearch.fields.time')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.events.map((event, index) => (
                <TableRow key={`${event.created_at ?? 'event'}-${index}`}>
                  <TableCell>
                    <div className="font-medium">
                      {event.stateName ||
                        event.stateType ||
                        event.event_type ||
                        t('deepSearch.fallback.event')}
                    </div>
                    {event.stateType ? (
                      <div className="text-xs text-muted-foreground">
                        {event.stateType}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {event.message || t('deepSearch.fallback.noMessage')}
                  </TableCell>
                  <TableCell>
                    {formatJobDate(event.created_at, locale, unavailableLabel)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('deepSearch.detail.noHistory')}
        </p>
      )}
      {history?.prefectUiUrl ? (
        <Button variant="link" asChild className="mt-2 h-auto p-0">
          <a href={history.prefectUiUrl} target="_blank" rel="noreferrer">
            {t('deepSearch.actions.openInPrefect')}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function TechnicalResultDetails({ result }: { result: unknown }) {
  const t = useTranslations('catalog');
  const resultRecord = asRecord(result);
  const trace = asRecord(resultRecord?.trace);
  const initialRetrieval = asRecord(trace?.initialRetrieval);
  const initialHits = asRecordArray(initialRetrieval?.hits);
  const citationExpansions = asRecordArray(trace?.citationExpansions);

  return (
    <div className="space-y-4 border-t pt-5">
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          {t('deepSearch.detail.initialHits', {
            count: initialHits.length,
          })}
        </summary>
        {initialHits.length ? (
          <div className="mt-3 overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('deepSearch.fields.rank')}</TableHead>
                  <TableHead>{t('deepSearch.fields.score')}</TableHead>
                  <TableHead>{t('deepSearch.fields.text')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {initialHits.map((hit, index) => (
                  <TableRow key={`${hit.chunkId ?? 'hit'}-${index}`}>
                    <TableCell>{String(hit.rank ?? index + 1)}</TableCell>
                    <TableCell>
                      {String(
                        hit.score ?? t('deepSearch.fallback.notAvailable'),
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {String(hit.text ?? t('deepSearch.fallback.noText'))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {t('deepSearch.detail.noInitialHits')}
          </p>
        )}
      </details>

      <details className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {t('deepSearch.detail.citationDetails', {
            count: citationExpansions.length,
          })}
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
          {stringifyJson(citationExpansions)}
        </pre>
      </details>

      <details className="border-t pt-4">
        <summary className="cursor-pointer text-sm font-semibold">
          {t('deepSearch.detail.rawTraceJson')}
        </summary>
        <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
          {stringifyJson(trace ?? resultRecord)}
        </pre>
      </details>
    </div>
  );
}

interface ConfigRow {
  label: string;
  value: string;
  mono?: boolean;
}

function ConfigGroup({ title, rows }: { title: string; rows: ConfigRow[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="mt-3 grid gap-3">
        {rows.map((row) => (
          <div key={row.label} className="grid gap-1 sm:grid-cols-[11rem_1fr]">
            <dt className="text-xs font-medium uppercase text-muted-foreground">
              {row.label}
            </dt>
            <dd
              className={
                row.mono ? 'break-all font-mono text-sm' : 'break-words text-sm'
              }
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  wide = false,
  multiline = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  multiline?: boolean;
}) {
  const valueClassName = mono
    ? 'mt-1 break-all font-mono text-sm'
    : multiline
      ? 'mt-1 whitespace-pre-wrap break-words text-sm leading-6'
      : 'mt-1 break-words text-sm';

  return (
    <div className={wide ? 'md:col-span-2' : undefined}>
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <div className={valueClassName}>{value}</div>
    </div>
  );
}

interface RlmProgressMetrics {
  steps: string | null;
  toolCalls: string | null;
  subLlmCalls: string | null;
  searchCalls: string | null;
  windowCalls: string | null;
  uniqueChunks: string | null;
  uniqueAudioHashes: string | null;
  retrievedContextChars: string | null;
}

interface EffectiveDeepSearchConfig {
  hasResolvedConfig: boolean;
  retrieval: {
    topK: string | null;
    includeNeighbors: boolean | null;
    neighborCount: string | null;
    windowNeighborCount: string | null;
  };
  execution: {
    mode: string | null;
    executor: string | null;
    workload: string | null;
    adapterMode: string | null;
    replBackend: string | null;
    seed: string | null;
    logDir: string | null;
    lmProfile: string | null;
    lmModel: string | null;
    subLmProfile: string | null;
    subLmModel: string | null;
  };
}

function getRlmProgressMetrics(job: DeepSearchJob): RlmProgressMetrics {
  const progress = asRecord(job.rlmProgress);
  const result = asRecord(job.result);
  const trace = asRecord(result?.trace);
  const rlm = asRecord(trace?.rlm);
  const coverage = getTraceCoverageMetrics(trace);

  return {
    steps: stringValue(
      numberValue(progress?.steps, progress?.rlmSteps),
      rlm?.iterations,
      trace?.rlmIterations,
    ),
    toolCalls: stringValue(
      numberValue(
        progress?.toolCalls,
        progress?.tool_calls,
        arrayLength(trace?.rlmToolCalls),
        arrayLength(trace?.toolCalls),
      ),
    ),
    subLlmCalls: stringValue(
      numberValue(
        progress?.subLlmCalls,
        progress?.subllmCalls,
        progress?.sub_llm_calls,
        progress?.subllm_calls,
        rlm?.subLlmCalls,
        rlm?.subllmCalls,
      ),
    ),
    searchCalls: stringValue(
      numberValue(
        progress?.searchCalls,
        progress?.search_calls,
        coverage.searchCalls,
      ),
    ),
    windowCalls: stringValue(
      numberValue(
        progress?.windowCalls,
        progress?.window_calls,
        coverage.windowCalls,
      ),
    ),
    uniqueChunks: stringValue(
      numberValue(
        progress?.uniqueChunks,
        progress?.unique_chunks,
        coverage.uniqueChunks,
      ),
    ),
    uniqueAudioHashes: stringValue(
      numberValue(
        progress?.uniqueAudioHashes,
        progress?.unique_audio_hashes,
        coverage.uniqueAudioHashes,
      ),
    ),
    retrievedContextChars: stringValue(
      numberValue(
        progress?.retrievedContextChars,
        progress?.retrieved_context_chars,
        coverage.retrievedContextChars,
      ),
    ),
  };
}

interface TraceCoverageMetrics {
  searchCalls: number | null;
  windowCalls: number | null;
  uniqueChunks: number | null;
  uniqueAudioHashes: number | null;
  retrievedContextChars: number | null;
}

function getTraceCoverageMetrics(
  trace: Record<string, unknown> | null,
): TraceCoverageMetrics {
  const followUpSearches = asRecordArray(trace?.followUpSearches);
  const citationExpansions = asRecordArray(trace?.citationExpansions);
  const rlmCitationExpansions = asRecordArray(trace?.rlmCitationExpansions);
  const windowExpansions = rlmCitationExpansions.length
    ? rlmCitationExpansions
    : citationExpansions;
  const chunkIds = new Set<string>();
  const audioHashes = new Set<string>();
  let retrievedContextChars = 0;

  for (const search of followUpSearches) {
    const metricContextChars = numberValue(search.contextCharCount);
    if (metricContextChars !== null) {
      retrievedContextChars += metricContextChars;
    }

    for (const result of asRecordArray(search.results)) {
      addStringValue(chunkIds, result.chunkId);
      addStringValue(audioHashes, result.audioHash);
      if (
        metricContextChars === null &&
        typeof result.contextText === 'string'
      ) {
        retrievedContextChars += result.contextText.length;
      }
    }
  }

  for (const window of windowExpansions) {
    const metricContextChars = numberValue(window.contextCharCount);
    if (metricContextChars !== null) {
      retrievedContextChars += metricContextChars;
    } else if (typeof window.contextText === 'string') {
      retrievedContextChars += window.contextText.length;
    }

    const chunk = asRecord(window.chunk);
    if (chunk) {
      addStringValue(chunkIds, chunk.chunkId);
      addStringValue(audioHashes, chunk.audioHash);
    }

    const neighbors = asRecord(window.neighbors);
    for (const key of ['before', 'after']) {
      for (const item of asRecordArray(neighbors?.[key])) {
        addStringValue(chunkIds, item.chunkId);
        addStringValue(audioHashes, item.audioHash);
      }
    }
  }

  return {
    searchCalls: followUpSearches.length || null,
    windowCalls: windowExpansions.length || null,
    uniqueChunks: chunkIds.size || null,
    uniqueAudioHashes: audioHashes.size || null,
    retrievedContextChars: retrievedContextChars || null,
  };
}

function getEffectiveDeepSearchConfig(
  job: DeepSearchJob,
): EffectiveDeepSearchConfig {
  const payloadRetrieval = asRecord(job.payload.retrieval);
  const payloadExecution = asRecord(job.payload.execution);
  const result = asRecord(job.result);
  const trace = asRecord(result?.trace);
  const effectiveRetrieval = asRecord(trace?.effectiveRetrieval);
  const effectiveExecution = asRecord(trace?.effectiveExecution);
  const rlm = asRecord(trace?.rlm);
  const mainLm = asRecord(rlm?.main);
  const subLm = asRecord(rlm?.sub);
  const isRlmTrace =
    stringValue(trace?.executionMode) === 'rlm' || Boolean(rlm);
  const legacyRlmRetrievalDefault = effectiveRetrieval ? null : isRlmTrace;

  return {
    hasResolvedConfig: Boolean(
      effectiveRetrieval ||
      effectiveExecution ||
      rlm ||
      stringValue(trace?.executionMode),
    ),
    retrieval: {
      topK: stringValue(
        effectiveRetrieval?.topK,
        effectiveRetrieval?.top_k,
        payloadRetrieval?.top_k,
        payloadRetrieval?.topK,
      ),
      includeNeighbors: booleanValue(
        effectiveRetrieval?.includeNeighbors,
        effectiveRetrieval?.include_neighbors,
        payloadRetrieval?.include_neighbors,
        payloadRetrieval?.includeNeighbors,
        legacyRlmRetrievalDefault ? true : undefined,
      ),
      neighborCount: stringValue(
        effectiveRetrieval?.neighborCount,
        effectiveRetrieval?.neighbor_count,
        payloadRetrieval?.neighbor_count,
        payloadRetrieval?.neighborCount,
        legacyRlmRetrievalDefault ? 1 : undefined,
      ),
      windowNeighborCount: stringValue(
        effectiveRetrieval?.windowNeighborCount,
        effectiveRetrieval?.window_neighbor_count,
        payloadRetrieval?.window_neighbor_count,
        payloadRetrieval?.windowNeighborCount,
        asRecord(payloadRetrieval?.window)?.neighbor_count,
        asRecord(payloadRetrieval?.window)?.neighborCount,
        asRecord(payloadExecution?.window)?.neighbor_count,
        asRecord(payloadExecution?.window)?.neighborCount,
        payloadExecution?.window_neighbor_count,
        payloadExecution?.windowNeighborCount,
        payloadExecution?.citation_neighbor_count,
        payloadExecution?.citationNeighborCount,
        legacyRlmRetrievalDefault ? 1 : undefined,
      ),
    },
    execution: {
      mode: stringValue(
        effectiveExecution?.mode,
        trace?.executionMode,
        payloadExecution?.mode,
        payloadExecution?.execution_mode,
        payloadExecution?.executionMode,
      ),
      executor: stringValue(effectiveExecution?.executor, trace?.executor),
      workload: stringValue(
        effectiveExecution?.workload,
        trace?.workload,
        isRlmTrace ? 'besedy_deep_search' : undefined,
      ),
      adapterMode: stringValue(
        effectiveExecution?.adapterMode,
        effectiveExecution?.adapter_mode,
        rlm?.adapterMode,
        rlm?.adapter_mode,
        payloadRetrieval?.adapter_mode,
        payloadRetrieval?.adapterMode,
      ),
      replBackend: stringValue(
        effectiveExecution?.replBackend,
        effectiveExecution?.repl_backend,
        rlm?.replBackend,
        rlm?.repl_backend,
      ),
      seed: stringValue(effectiveExecution?.seed, isRlmTrace ? 1 : undefined),
      logDir: stringValue(effectiveExecution?.logDir, rlm?.logDir),
      lmProfile: stringValue(
        effectiveExecution?.lmProfile,
        effectiveExecution?.lm_profile,
        mainLm?.ref,
        payloadRetrieval?.lm_profile,
        payloadRetrieval?.lmProfile,
      ),
      lmModel: stringValue(
        effectiveExecution?.lmModelId,
        effectiveExecution?.lmModel,
        effectiveExecution?.lm_model,
        mainLm?.modelId,
        mainLm?.model,
      ),
      subLmProfile: stringValue(
        effectiveExecution?.subLmProfile,
        effectiveExecution?.sub_lm_profile,
        subLm?.ref,
        payloadRetrieval?.sub_lm_profile,
        payloadRetrieval?.subLmProfile,
      ),
      subLmModel: stringValue(
        effectiveExecution?.subLmModelId,
        effectiveExecution?.subLmModel,
        effectiveExecution?.sub_lm_model,
        subLm?.modelId,
        subLm?.model,
      ),
    },
  };
}

function formatOptionalBoolean(
  value: boolean | null,
  trueLabel: string,
  falseLabel: string,
  fallbackLabel: string,
) {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return fallbackLabel;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'boolean') {
      return String(value);
    }
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function arrayLength(...values: unknown[]): number | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value.length;
    }
  }
  return null;
}

function addStringValue(values: Set<string>, value: unknown) {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim();
  if (normalized) {
    values.add(normalized);
  }
}

function booleanValue(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return null;
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase text-muted-foreground">
        {title}
      </div>
      <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/40 p-3 text-xs whitespace-pre-wrap">
        {stringifyJson(value)}
      </pre>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}
