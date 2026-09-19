import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadManagerBridge } from '@/components/offline/download-manager-bridge';

const mocks = vi.hoisted(() => ({
  downloadManager: {
    hydrate: vi.fn(),
    setOnline: vi.fn(),
    setUserId: vi.fn(),
  },
  flushPendingPlaybackProgress: vi.fn(),
  getClientSession: vi.fn(),
  registerBlocker: vi.fn(),
  subscribeToPendingPlaybackProgress: vi.fn(() => vi.fn()),
  useDownloadManager: vi.fn(),
  useOnlineStatus: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('@/contexts/reload-safety-context', () => ({
  useReloadSafety: () => ({ registerBlocker: mocks.registerBlocker }),
}));
vi.mock('@/contexts/session-context', () => ({
  useSession: mocks.useSession,
}));
vi.mock('@/hooks/use-downloads', () => ({
  useDownloadManager: mocks.useDownloadManager,
}));
vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: mocks.useOnlineStatus,
}));
vi.mock('@/lib/auth/client', () => ({
  getSession: mocks.getClientSession,
}));
vi.mock('@/lib/offline/download-manager', () => ({
  downloadManager: mocks.downloadManager,
}));
vi.mock('@/lib/offline/playback-progress-sync', () => ({
  flushPendingPlaybackProgress: mocks.flushPendingPlaybackProgress,
  subscribeToPendingPlaybackProgress:
    mocks.subscribeToPendingPlaybackProgress,
}));

describe('DownloadManagerBridge session recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.downloadManager.hydrate.mockResolvedValue(undefined);
    mocks.flushPendingPlaybackProgress.mockResolvedValue({
      attempted: 0,
      synced: 0,
      discarded: 0,
      failed: 0,
    });
    mocks.getClientSession.mockResolvedValue({ data: null });
    mocks.useSession.mockReturnValue({ session: null });
    mocks.useOnlineStatus.mockReturnValue({ isOnline: true });
    mocks.useDownloadManager.mockReturnValue({
      activeKey: null,
      records: [{ key: 'download-1', userId: 'owner-1' }],
    });
    Object.defineProperty(navigator, 'onLine', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovers on lifecycle events without polling or record-update restarts', async () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const { rerender } = render(<DownloadManagerBridge />);

    await waitFor(() => expect(mocks.getClientSession).toHaveBeenCalledTimes(1));
    expect(intervalSpy).not.toHaveBeenCalledWith(
      expect.any(Function),
      2_000,
    );

    mocks.useDownloadManager.mockReturnValue({
      activeKey: null,
      records: [{ key: 'download-1', userId: 'owner-1', progress: 50 }],
    });
    rerender(<DownloadManagerBridge />);
    await act(async () => {});
    expect(mocks.getClientSession).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(mocks.getClientSession).toHaveBeenCalledTimes(2));

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(mocks.getClientSession).toHaveBeenCalledTimes(3));
  });

  it('flushes pending progress after recovering a verified user', async () => {
    mocks.getClientSession.mockResolvedValue({
      data: { user: { id: 'owner-1' } },
    });

    render(<DownloadManagerBridge />);

    await waitFor(() =>
      expect(mocks.flushPendingPlaybackProgress).toHaveBeenCalledWith('owner-1'),
    );
  });

  it('starts recovery when the online state reconnects', async () => {
    mocks.useOnlineStatus.mockReturnValue({ isOnline: false });
    const { rerender } = render(<DownloadManagerBridge />);

    await act(async () => {});
    expect(mocks.getClientSession).not.toHaveBeenCalled();

    mocks.useOnlineStatus.mockReturnValue({ isOnline: true });
    rerender(<DownloadManagerBridge />);

    await waitFor(() => expect(mocks.getClientSession).toHaveBeenCalledTimes(1));
  });
});
