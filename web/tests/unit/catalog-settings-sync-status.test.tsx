import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogSettingsConfigCard } from '@/app/(app)/catalog/[catalogId]/settings/catalog-settings-config-card';
import CatalogSettingsContent from '@/app/(app)/catalog/[catalogId]/settings/catalog-settings-content';
import { ApiError, fetchJson } from '@/lib/api/fetch-json';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock('@/hooks/use-catalog-context', () => ({
  useCatalogContext: () => ({
    catalogNotFound: false,
    catalogValidationLoading: false,
  }),
}));
vi.mock('@/lib/api/fetch-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/fetch-json')>()),
  fetchJson: vi.fn(),
}));

const groupId = '20251222_144441';
const successAt = '2026-11-05T10:00:00Z';
const source = {
  sourceKey: 'metadata',
  status: 'ERROR',
  syncedAt: '2026-11-06T10:00:00Z',
  lastSuccessfulAt: successAt,
  lastError: 'Invalid metadata catalog CSV: MissingQuotes',
  rowCount: 12,
};
function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderCard(canEditPathsAndFlags = true, queryClient = client()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <CatalogSettingsConfigCard
        catalogId={groupId}
        canEditPathsAndFlags={canEditPathsAndFlags}
        configDraft={null}
        configError={null}
        isEditing={false}
        isLoading={false}
        isSyncPending={false}
        isUpdatePending={false}
        onCancelEditing={vi.fn()}
        onDraftChange={vi.fn()}
        onSave={vi.fn()}
        onStartEditing={vi.fn()}
        onSync={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('catalog settings sync status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchJson).mockResolvedValue({ groupId, sources: [source] });
  });

  it('hides sync controls and never requests operator errors for a catalog administrator', () => {
    renderCard(false);
    expect(
      screen.queryByRole('button', { name: 'buttons.syncCatalog' }),
    ).not.toBeInTheDocument();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('shows the last successful timestamp and failed source cause to a system administrator', async () => {
    const { container } = renderCard();
    expect(await screen.findByText(source.lastError)).toBeInTheDocument();
    expect(screen.getByText('metadata: ERROR')).toBeInTheDocument();
    expect(container.querySelector('time')).toHaveAttribute(
      'datetime',
      successAt,
    );
    expect(
      screen.getByRole('button', { name: 'buttons.syncCatalog' }),
    ).toBeInTheDocument();
  });

  it('shows an explicit empty state before the first sync', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ groupId, sources: [] });
    renderCard();
    expect(await screen.findByText('notRun')).toBeInTheDocument();
  });

  it('does not invent a last-success timestamp for an older failure', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ groupId, sources: [{ ...source, lastSuccessfulAt: null }] });
    const { container } = renderCard();
    expect(await screen.findByText('lastSuccess: unknown')).toBeInTheDocument();
    expect(container.querySelector('time')).toBeNull();
  });

  it('hides cached source errors after authorization fails on refresh', async () => {
    const queryClient = client();
    queryClient.setQueryData(['catalog-sync-status', groupId], {
      groupId,
      sources: [source],
    });
    vi.mocked(fetchJson).mockRejectedValue(new ApiError('Unauthorized', 403));
    renderCard(true, queryClient);
    expect(await screen.findByRole('alert')).toHaveTextContent('loadError');
    expect(screen.queryByText(source.lastError)).not.toBeInTheDocument();
  });

  it('refreshes status after a failed manual sync and retains its actual error toast', async () => {
    let failed = false;
    vi.mocked(fetchJson).mockImplementation(async (input, init) => {
      if (
        String(input) === '/api/admin/catalog-sync' &&
        init?.method === 'POST'
      ) {
        failed = true;
        throw new Error(source.lastError);
      }
      if (String(input).startsWith('/api/admin/catalog-sync?'))
        return { groupId, sources: failed ? [source] : [] };
      throw new Error(`Unexpected request ${input}`);
    });
    render(
      <QueryClientProvider client={client()}>
        <CatalogSettingsContent
          catalogId={groupId}
          canEditPathsAndFlags
          cards={{
            configuration: true,
            access: false,
            correctionGuide: false,
            eventHealth: false,
            lookups: false,
            transcriptExports: false,
          }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('notRun');
    await userEvent.click(
      screen.getByRole('button', { name: 'buttons.syncCatalog' }),
    );
    expect(await screen.findByText(source.lastError)).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: source.lastError }),
      ),
    );
  });
});
