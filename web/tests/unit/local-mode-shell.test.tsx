import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalModeShell,
  legacyRedirectTarget,
  resolveLocalRoute,
} from '@/components/offline/local-mode-shell';

const mocks = vi.hoisted(() => ({
  pathname: '/downloads',
  search: '',
  eventDetail: vi.fn(),
  recordingContent: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/components/offline/downloads-content', () => ({
  DownloadsContent: () => <div data-testid="downloads-content" />,
}));

vi.mock('@/components/offline/local-event-list', () => ({
  LocalEventList: ({ catalogId }: { catalogId: string }) => (
    <div data-testid="local-event-list" data-catalog={catalogId} />
  ),
}));

vi.mock('@/components/catalog/event-detail', () => ({
  EventDetail: (props: unknown) => {
    mocks.eventDetail(props);
    return <div data-testid="event-detail" />;
  },
}));

vi.mock(
  '@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content',
  () => ({
    default: (props: unknown) => {
      mocks.recordingContent(props);
      return <div data-testid="recording-content" />;
    },
  }),
);

const HASH = 'a'.repeat(64);

describe('resolveLocalRoute', () => {
  it('maps the normal URLs onto local presentations', () => {
    expect(resolveLocalRoute('/downloads')).toEqual({ kind: 'downloads' });
    expect(resolveLocalRoute('/')).toEqual({ kind: 'downloads' });
    expect(resolveLocalRoute('/catalog')).toEqual({ kind: 'downloads' });
    expect(resolveLocalRoute('/catalog/cat-1')).toEqual({
      kind: 'catalog',
      catalogId: 'cat-1',
    });
    expect(resolveLocalRoute('/catalog/cat-1/event/7')).toEqual({
      kind: 'event',
      catalogId: 'cat-1',
      eventId: 7,
    });
    expect(resolveLocalRoute(`/catalog/cat-1/recording/${HASH}`)).toEqual({
      kind: 'recording',
      catalogId: 'cat-1',
      hash: HASH,
    });
  });

  it('treats everything else as unavailable offline', () => {
    expect(resolveLocalRoute('/settings').kind).toBe('unavailable');
    expect(resolveLocalRoute('/catalog/cat-1/event/abc').kind).toBe('unavailable');
    expect(resolveLocalRoute('/catalog/cat-1/event/7/edit').kind).toBe('unavailable');
    expect(resolveLocalRoute('/catalog/cat-1/recording/short').kind).toBe('unavailable');
  });
});

describe('LocalModeShell', () => {
  beforeEach(() => {
    mocks.search = '';
    mocks.eventDetail.mockClear();
    mocks.recordingContent.mockClear();
  });

  it("honours a legacy worker's ?from= redirect, restoring path and search before routing", () => {
    mocks.pathname = '/downloads';
    mocks.search = `from=${encodeURIComponent(`/catalog/cat-1/recording/${HASH}?seek=10&fromRadio=true`)}`;
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const { rerender } = render(<LocalModeShell />);

    // Nothing is routed until the router reflects the restored URL, so the
    // recording page sees its query parameters at first render.
    expect(screen.queryByTestId('recording-content')).not.toBeInTheDocument();
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      `/catalog/cat-1/recording/${HASH}?seek=10&fromRadio=true`,
    );

    mocks.pathname = `/catalog/cat-1/recording/${HASH}`;
    mocks.search = 'seek=10&fromRadio=true';
    rerender(<LocalModeShell />);
    expect(screen.getByTestId('recording-content')).toBeInTheDocument();
    replaceState.mockRestore();
  });

  it('ignores a ?from= that does not stay on this origin', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    for (const from of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/x']) {
      mocks.pathname = '/downloads';
      mocks.search = `from=${encodeURIComponent(from)}`;
      const { unmount } = render(<LocalModeShell />);
      expect(screen.getByTestId('downloads-content')).toBeInTheDocument();
      unmount();
    }
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it('resolves legacy redirect targets as same-origin URLs with their search', () => {
    expect(legacyRedirectTarget('/catalog/c/event/7?seek=3')).toBe('/catalog/c/event/7?seek=3');
    expect(legacyRedirectTarget('/\\evil.example/x')).toBeNull();
    expect(legacyRedirectTarget('//evil.example/x')).toBeNull();
    expect(legacyRedirectTarget('http://evil.example/x')).toBeNull();
    expect(legacyRedirectTarget(null)).toBeNull();
  });

  it('renders the Downloads library at its own URL', () => {
    mocks.pathname = '/downloads';
    render(<LocalModeShell />);
    expect(screen.getByTestId('downloads-content')).toBeInTheDocument();
  });

  it('renders the shared event page for a normal event URL with server-only actions closed', () => {
    mocks.pathname = '/catalog/cat-1/event/7';
    render(<LocalModeShell />);
    expect(screen.getByTestId('event-detail')).toBeInTheDocument();
    expect(mocks.eventDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogId: 'cat-1',
        eventId: 7,
        canEdit: false,
        showAllColumns: false,
      }),
    );
  });

  it('renders the shared recording page for a normal recording URL', () => {
    mocks.pathname = `/catalog/cat-1/recording/${HASH}`;
    render(<LocalModeShell />);
    expect(mocks.recordingContent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { catalogId: 'cat-1', hash: HASH },
        skipCatalogValidation: true,
      }),
    );
  });

  it('renders the downloaded events of a catalog for its list URL', () => {
    mocks.pathname = '/catalog/cat-1';
    render(<LocalModeShell />);
    expect(screen.getByTestId('local-event-list')).toHaveAttribute(
      'data-catalog',
      'cat-1',
    );
  });

  it('explains that other pages need a connection and links to Downloads', () => {
    mocks.pathname = '/settings';
    render(<LocalModeShell />);
    expect(screen.getByTestId('offline-unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/downloads');
  });
});
