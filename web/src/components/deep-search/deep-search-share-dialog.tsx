'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Loader2, Share2, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import { fetchJson } from '@/lib/api/fetch-json';
import {
  deepSearchJobShareSchema,
  deepSearchJobSharesSchema,
  deepSearchShareUserSearchSchema,
  type DeepSearchJob,
  type DeepSearchJobShare,
  type DeepSearchJobShares,
  type DeepSearchShareUserSearch,
} from '@/lib/jobs-api/schemas';
import { useDebounce } from '@/hooks/use-debounce';
import { useToast } from '@/hooks/use-toast';

interface DeepSearchShareDialogProps {
  catalogId: string;
  job: DeepSearchJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeepSearchShareDialog({
  catalogId,
  job,
  open,
  onOpenChange,
}: DeepSearchShareDialogProps) {
  const t = useTranslations('catalog');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [searchValue, setSearchValue] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const debouncedSearch = useDebounce(searchValue, 300);
  const jobId = job?.id ?? '';

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setSearchValue('');
      setSelectedUserId('');
    }
    onOpenChange(nextOpen);
  }

  const sharesQuery = useQuery<DeepSearchJobShares>({
    queryKey: ['deep-search-job-shares', catalogId, jobId],
    queryFn: () =>
      fetchJson<DeepSearchJobShares>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/shares`,
        { schema: deepSearchJobSharesSchema },
      ),
    enabled: open && Boolean(jobId),
  });

  const userSearchQuery = useQuery<DeepSearchShareUserSearch>({
    queryKey: ['deep-search-share-users', catalogId, jobId, debouncedSearch],
    queryFn: () => {
      if (debouncedSearch.length < 2) {
        return { users: [] };
      }
      return fetchJson<DeepSearchShareUserSearch>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/share-users?search=${encodeURIComponent(debouncedSearch)}`,
        { schema: deepSearchShareUserSearchSchema },
      );
    },
    enabled: open && Boolean(jobId) && debouncedSearch.length >= 2,
  });

  const addShareMutation = useMutation({
    mutationFn: (userId: string) =>
      fetchJson<DeepSearchJobShare>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/shares`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId }),
          schema: deepSearchJobShareSchema,
        },
      ),
    onSuccess: () => {
      setSearchValue('');
      setSelectedUserId('');
      invalidateShareData();
      toast({
        title: t('deepSearch.share.addSuccess'),
      });
    },
    onError: (error) => {
      toast({
        title: t('deepSearch.share.addError'),
        description:
          error instanceof Error
            ? error.message
            : t('deepSearch.fallback.requestFailed'),
        variant: 'destructive',
      });
    },
  });

  const removeShareMutation = useMutation({
    mutationFn: (userId: string) =>
      fetchJson<{ ok: boolean }>(
        `/api/catalogs/${catalogId}/deep-search/jobs/${jobId}/shares/${userId}`,
        {
          method: 'DELETE',
        },
      ),
    onSuccess: () => {
      invalidateShareData();
      toast({
        title: t('deepSearch.share.removeSuccess'),
      });
    },
    onError: (error) => {
      toast({
        title: t('deepSearch.share.removeError'),
        description:
          error instanceof Error
            ? error.message
            : t('deepSearch.fallback.requestFailed'),
        variant: 'destructive',
      });
    },
  });

  function invalidateShareData() {
    queryClient.invalidateQueries({
      queryKey: ['deep-search-job-shares', catalogId, jobId],
    });
    queryClient.invalidateQueries({
      queryKey: ['deep-search-share-users', catalogId, jobId],
    });
    queryClient.invalidateQueries({
      queryKey: ['deep-search-jobs', catalogId],
    });
  }

  const options: ComboboxOption[] = (userSearchQuery.data?.users ?? []).map(
    (user) => ({
      id: user.id,
      label: user.name || user.email || user.id,
      description: user.name ? user.email || undefined : undefined,
      type: 'available',
      image: user.image,
    }),
  );

  const selectedUser = userSearchQuery.data?.users.find(
    (user) => user.id === selectedUserId,
  );
  const canAdd = Boolean(selectedUserId) && !addShareMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('deepSearch.share.title')}</DialogTitle>
          <DialogDescription>
            {job?.payload.query
              ? t('deepSearch.share.descriptionWithQuery', {
                  query: job.payload.query,
                })
              : t('deepSearch.share.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <h3 className="text-sm font-medium">
              {t('deepSearch.share.currentShares')}
            </h3>
            {sharesQuery.isPending ? (
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('deepSearch.share.loadingShares')}
              </div>
            ) : sharesQuery.data?.shares.length ? (
              <div className="divide-y rounded-md border">
                {sharesQuery.data.shares.map((share) => (
                  <div
                    key={share.sharedWithUserId}
                    className="flex items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {share.user.name || share.user.email || share.user.id}
                      </div>
                      {share.user.email ? (
                        <div className="truncate text-xs text-muted-foreground">
                          {share.user.email}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('deepSearch.share.removeShare')}
                      disabled={removeShareMutation.isPending}
                      onClick={() =>
                        removeShareMutation.mutate(share.sharedWithUserId)
                      }
                    >
                      {removeShareMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                {t('deepSearch.share.noShares')}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>{t('deepSearch.share.addUserLabel')}</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Combobox
                value={selectedUserId}
                onValueChange={setSelectedUserId}
                searchValue={searchValue}
                onSearchChange={(value) => {
                  setSearchValue(value);
                  setSelectedUserId('');
                }}
                options={options}
                isLoading={userSearchQuery.isFetching}
                placeholder={t('deepSearch.share.userSearchPlaceholder')}
                emptyMessage={t('deepSearch.share.noUserResults')}
                availableSectionLabel={t('deepSearch.share.availableUsers')}
                shortSearchMessage={t('deepSearch.share.shortSearchMessage')}
                showInviteOption={false}
                onSelect={(option) => {
                  setSelectedUserId(option.id);
                  setSearchValue(option.label);
                }}
                className="flex-1"
              />
              <Button
                type="button"
                disabled={!canAdd}
                onClick={() => {
                  if (selectedUserId) {
                    addShareMutation.mutate(selectedUserId);
                  }
                }}
              >
                {addShareMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Share2 className="h-4 w-4" />
                )}
                {selectedUser
                  ? t('deepSearch.share.addUser')
                  : t('deepSearch.share.addUser')}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('deepSearch.actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
