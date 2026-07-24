'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { fetchJson } from '@/lib/api/fetch-json';
import {
  deepSearchJobSchema,
  type DeepSearchJob,
} from '@/lib/jobs-api/schemas';
import type { DeepSearchJobDraft } from './deep-search-job-draft';

interface DeepSearchNewJobDialogProps {
  catalogId: string;
  catalogLabel: string;
  deepSearchDefaultInstructions: string;
  draft: DeepSearchJobDraft | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeepSearchNewJobDialog({
  catalogId,
  catalogLabel,
  deepSearchDefaultInstructions,
  draft,
  open,
  onOpenChange,
}: DeepSearchNewJobDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DeepSearchNewJobDialogForm
          catalogId={catalogId}
          catalogLabel={catalogLabel}
          deepSearchDefaultInstructions={deepSearchDefaultInstructions}
          draft={draft}
          onOpenChange={onOpenChange}
        />
      ) : null}
    </Dialog>
  );
}

function DeepSearchNewJobDialogForm({
  catalogId,
  catalogLabel,
  deepSearchDefaultInstructions,
  draft,
  onOpenChange,
}: Omit<DeepSearchNewJobDialogProps, 'open'>) {
  const t = useTranslations('catalog');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [queryText, setQueryText] = useState(draft?.query ?? '');
  const [instructionsText, setInstructionsText] = useState(
    draft?.instructions ?? deepSearchDefaultInstructions,
  );

  const submitMutation = useMutation({
    mutationFn: (payload: DeepSearchJobDraft) =>
      fetchJson<DeepSearchJob>(`/api/catalogs/${catalogId}/deep-search/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        schema: deepSearchJobSchema,
      }),
    onSuccess: async (job) => {
      onOpenChange(false);
      await queryClient.invalidateQueries({
        queryKey: ['deep-search-jobs', catalogId],
      });
      router.push(`/catalog/${catalogId}/deep-search/${job.id}`);
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = queryText.trim();
    const instructions = instructionsText.trim();
    if (!query) return;
    submitMutation.mutate({ query, instructions });
  }

  return (
    <DialogContent className="overflow-y-auto sm:max-w-2xl">
      <form onSubmit={handleSubmit} className="contents">
        <DialogHeader>
          <DialogTitle>{t('deepSearch.newJob')}</DialogTitle>
          <DialogDescription>
            {t('deepSearch.dialog.description', { catalogLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="deep-search-query">
              {t('deepSearch.dialog.queryLabel')}
            </Label>
            <Textarea
              id="deep-search-query"
              value={queryText}
              onChange={(event) => setQueryText(event.target.value)}
              placeholder={t('deepSearch.queryPlaceholder')}
              className="min-h-28 resize-y"
              maxLength={4000}
              required
            />
            <div className="text-right text-xs text-muted-foreground">
              {queryText.length}/4000
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="deep-search-instructions">
              {t('deepSearch.dialog.instructionsLabel')}
            </Label>
            <Textarea
              id="deep-search-instructions"
              value={instructionsText}
              onChange={(event) => setInstructionsText(event.target.value)}
              placeholder={t('deepSearch.instructionsPlaceholder')}
              className="min-h-36 resize-y"
              maxLength={4000}
              required
            />
            <div className="text-right text-xs text-muted-foreground">
              {instructionsText.length}/4000
            </div>
          </div>
        </div>
        {submitMutation.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t('deepSearch.dialog.submitErrorTitle')}</AlertTitle>
            <AlertDescription>
              {submitMutation.error instanceof Error
                ? submitMutation.error.message
                : t('deepSearch.fallback.requestFailed')}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitMutation.isPending}
          >
            {t('deepSearch.actions.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={
              submitMutation.isPending || !queryText.trim() || !instructionsText.trim()
            }
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t('deepSearch.actions.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
