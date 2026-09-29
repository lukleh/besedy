import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeRecordingWebState } from '@/lib/ingest/removal';

const replaceLostPrimaryRecording = vi.hoisted(() => vi.fn());
vi.mock('@/lib/catalog-events/primary-succession', () => ({
  replaceLostPrimaryRecording,
}));

const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  catalogEventRecording: { findUnique: vi.fn(), delete: vi.fn() },
  catalogEntry: { count: vi.fn() },
  audioMetadata: { deleteMany: vi.fn() },
  recordingPlaybackProgress: { deleteMany: vi.fn() },
  recordingNotification: { deleteMany: vi.fn() },
  workflowGroup: { update: vi.fn() },
}));

vi.mock('@/lib/db', () => ({
  default: {
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  },
}));

const CATALOG_ID = '20260201_120000';
const HASH = 'b'.repeat(64);

describe('removeRecordingWebState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.audioMetadata.deleteMany.mockResolvedValue({ count: 1 });
    tx.catalogEntry.count.mockResolvedValue(0);
    tx.recordingPlaybackProgress.deleteMany.mockResolvedValue({ count: 3 });
    tx.recordingNotification.deleteMany.mockResolvedValue({ count: 2 });
  });

  it('detaches the recording, repairs an event that lost its primary, and deletes user-authored rows', async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue({ eventId: 42 });
    tx.catalogEventRecording.delete.mockResolvedValue({ isPrimary: true });
    replaceLostPrimaryRecording.mockResolvedValue({ kind: 'unreleased' });

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result).toEqual({
      detachedEventId: 42,
      promotedAudioHash: null,
      unreleasedEventId: 42,
      metadataDeleted: 1,
      progressDeleted: 3,
      progressRetained: false,
      notificationsDeleted: 2,
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.catalogEventRecording.delete).toHaveBeenCalledWith({
      where: {
        workflowGroupId_audioHash: {
          workflowGroupId: CATALOG_ID,
          audioHash: HASH,
        },
      },
      select: { isPrimary: true },
    });
    expect(replaceLostPrimaryRecording).toHaveBeenCalledWith(tx, CATALOG_ID, 42);
    expect(tx.audioMetadata.deleteMany).toHaveBeenCalledWith({
      where: { workflowGroupId: CATALOG_ID, audioHash: HASH },
    });
    expect(tx.recordingPlaybackProgress.deleteMany).toHaveBeenCalledWith({
      where: { audioHash: HASH },
    });
    expect(tx.recordingNotification.deleteMany).toHaveBeenCalledWith({
      where: { catalogId: CATALOG_ID, audioHash: HASH },
    });
    expect(tx.workflowGroup.update).toHaveBeenCalled();
  });

  it('reports the recording promoted to primary in place of the removed one', async () => {
    const promotedHash = 'c'.repeat(64);
    tx.catalogEventRecording.findUnique.mockResolvedValue({ eventId: 42 });
    tx.catalogEventRecording.delete.mockResolvedValue({ isPrimary: true });
    replaceLostPrimaryRecording.mockResolvedValue({
      kind: 'promoted',
      audioHash: promotedHash,
    });

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result.promotedAudioHash).toBe(promotedHash);
    expect(result.unreleasedEventId).toBeNull();
  });

  it('leaves the event alone when a non-primary recording is removed', async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue({ eventId: 42 });
    tx.catalogEventRecording.delete.mockResolvedValue({ isPrimary: false });

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result.detachedEventId).toBe(42);
    expect(result.unreleasedEventId).toBeNull();
    expect(replaceLostPrimaryRecording).not.toHaveBeenCalled();
  });

  it('handles recordings that are not attached to any event', async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue(null);

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(result.detachedEventId).toBeNull();
    expect(tx.catalogEventRecording.delete).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.audioMetadata.deleteMany).toHaveBeenCalled();
  });

  it('retains globally keyed playback progress while another catalog references the hash', async () => {
    tx.catalogEventRecording.findUnique.mockResolvedValue(null);
    tx.catalogEntry.count.mockResolvedValue(1);

    const result = await removeRecordingWebState(CATALOG_ID, HASH);

    expect(tx.catalogEntry.count).toHaveBeenCalledWith({
      where: { audioHash: HASH, workflowGroupId: { not: CATALOG_ID } },
    });
    expect(tx.recordingPlaybackProgress.deleteMany).not.toHaveBeenCalled();
    expect(result.progressDeleted).toBe(0);
    expect(result.progressRetained).toBe(true);
  });
});
