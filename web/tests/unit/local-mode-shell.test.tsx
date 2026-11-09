import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalModeShell } from '@/components/offline/local-mode-shell';
import { resolveLocalRoute } from '@/lib/offline/local-route';

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
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock('@/components/offline/downloads-content', () => ({
  DownloadsContent: () => <div data-testid="downloads-content" />,
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
    expect(resolveLocalRoute('/catalog/cat-1')).toEqual({ kind: 'downloads' });
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
    expect(resolveLocalRoute('/catalog/cat-1/event/abc').kind).toBe(
      'unavailable',
    );
    expect(resolveLocalRoute('/catalog/cat-1/event/7/edit').kind).toBe(
      'unavailable',
    );
    expect(resolveLocalRoute('/catalog/cat-1/recording/short').kind).toBe(
      'unavailable',
    );
  });
});

describe('LocalModeShell', () => {
  beforeEach(() => {
    mocks.search = '';
    mocks.eventDetail.mockClear();
    mocks.recordingContent.mockClear();
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

  it('shows Downloads directly when a catalog navigation cannot reach the server', () => {
    mocks.pathname = '/catalog/cat-1';
    mocks.search = 'tab=events&search=talk';
    const replaceState = vi.spyOn(window.history, 'replaceState');
    render(<LocalModeShell />);
    expect(screen.getByTestId('downloads-content')).toBeInTheDocument();
    expect(mocks.eventDetail).not.toHaveBeenCalled();
    expect(mocks.recordingContent).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    replaceState.mockRestore();
  });

  it('explains that other pages need a connection and links to Downloads', () => {
    mocks.pathname = '/settings';
    render(<LocalModeShell />);
    expect(screen.getByTestId('offline-unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/downloads');
  });
});
