import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DELETE,
  GET,
  POST,
} from '@/app/api/catalogs/[id]/recordings/[hash]/correction/publication/route';
import { POST as recover } from '@/app/api/catalogs/[id]/recordings/[hash]/correction/publication/recover/route';

const mocks = vi.hoisted(() => ({
  requireCorrectionAccess: vi.fn(),
  requireActiveWorkspace: vi.fn(),
  getPublicationEligibility: vi.fn(),
  listPublications: vi.fn(),
  publishTranscript: vi.fn(),
  unpublishTranscript: vi.fn(),
  reconcilePublication: vi.fn(),
  rollbackPublication: vi.fn(),
  logAuditEvent: vi.fn(),
}));

vi.mock('@/lib/correction/access', () => ({
  requireCorrectionAccess: mocks.requireCorrectionAccess,
}));
vi.mock('@/lib/correction/workspace-service', () => ({
  requireActiveWorkspace: mocks.requireActiveWorkspace,
}));
vi.mock('@/lib/correction/publication-eligibility', () => ({
  getPublicationEligibility: mocks.getPublicationEligibility,
}));
vi.mock('@/lib/correction/publication-service', () => ({
  listPublications: mocks.listPublications,
  publishTranscript: mocks.publishTranscript,
  unpublishTranscript: mocks.unpublishTranscript,
  reconcilePublication: mocks.reconcilePublication,
  rollbackPublication: mocks.rollbackPublication,
}));
vi.mock('@/lib/audit/logger', () => ({ logAuditEvent: mocks.logAuditEvent }));

const CATALOG_ID = '20260101_000000';
const AUDIO_HASH = 'a'.repeat(64);
const PUBLICATION_ID = '12345678-1234-4234-8234-123456789abc';
const context = {
  params: Promise.resolve({ id: CATALOG_ID, hash: AUDIO_HASH }),
};
const url = `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${AUDIO_HASH}/correction/publication`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireCorrectionAccess.mockResolvedValue({ userId: 'publisher-1' });
  mocks.requireActiveWorkspace.mockResolvedValue({
    id: 'workspace-1',
    publicationId: PUBLICATION_ID,
    canUnpublish: true,
    unpublishPending: false,
    lockedByPublicationId: null,
  });
  mocks.listPublications.mockResolvedValue([
    { id: PUBLICATION_ID, isActivePublication: true },
  ]);
  mocks.getPublicationEligibility.mockResolvedValue({ eligible: true });
});

describe('correction publication routes', () => {
  it('lets the publisher request whole Unpublish and reports asynchronous indexing', async () => {
    mocks.unpublishTranscript.mockResolvedValue({
      unpublished: true,
      pendingIndexSync: true,
    });

    const response = await DELETE(
      new NextRequest(url, { method: 'DELETE' }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      unpublished: true,
      pendingIndexSync: true,
    });
    expect(mocks.requireCorrectionAccess).toHaveBeenCalledWith(
      CATALOG_ID,
      AUDIO_HASH,
      'publish',
    );
    expect(mocks.unpublishTranscript).toHaveBeenCalledWith({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: 'publisher-1',
    });
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TRANSCRIPT_UNPUBLISHED',
        payload: { pendingIndexSync: true },
      }),
    );
  });

  it('returns one logical publication and its Unpublish controls', async () => {
    const response = await GET(new NextRequest(url), context);
    const body = await response.json();

    expect(body).toMatchObject({
      publicationId: PUBLICATION_ID,
      canUnpublish: true,
      unpublishPending: false,
      publications: [{ id: PUBLICATION_ID, isActivePublication: true }],
    });
    expect(body).not.toHaveProperty('readerPublicationId');
    expect(body).not.toHaveProperty('searchPublicationId');
  });

  it('publishes without the removed reader-restoration result', async () => {
    const result = {
      publicationId: PUBLICATION_ID,
      status: 'ACTIVATING',
      resumed: false,
      error: null,
    };
    mocks.publishTranscript.mockResolvedValue(result);

    const response = await POST(
      new NextRequest(url, { method: 'POST' }),
      context,
    );

    expect(await response.json()).toEqual(result);
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { publicationId: PUBLICATION_ID, status: 'ACTIVATING' },
      }),
    );
  });
});

describe('administrative publication recovery', () => {
  it('rejects the retired separate search-withdrawal action', async () => {
    const response = await recover(
      new NextRequest(`${url}/recover`, {
        method: 'POST',
        body: JSON.stringify({ action: 'withdraw_from_search' }),
      }),
      context,
    );

    expect(response.status).toBe(400);
    expect(mocks.unpublishTranscript).not.toHaveBeenCalled();
    expect(mocks.reconcilePublication).not.toHaveBeenCalled();
    expect(mocks.rollbackPublication).not.toHaveBeenCalled();
  });

  it.each(['reconcile', 'rollback'] as const)(
    "keeps %s scoped to the administrator's workspace",
    async (action) => {
      mocks.reconcilePublication.mockResolvedValue('SUCCEEDED');
      mocks.rollbackPublication.mockResolvedValue('ROLLING_BACK');
      const response = await recover(
        new NextRequest(`${url}/recover`, {
          method: 'POST',
          body: JSON.stringify({ action, publicationId: PUBLICATION_ID }),
        }),
        context,
      );

      expect(response.status).toBe(200);
      expect(mocks.requireCorrectionAccess).toHaveBeenCalledWith(
        CATALOG_ID,
        AUDIO_HASH,
        'administer',
      );
      expect(
        action === 'reconcile'
          ? mocks.reconcilePublication
          : mocks.rollbackPublication,
      ).toHaveBeenCalledWith(PUBLICATION_ID, 'workspace-1');
    },
  );
});
