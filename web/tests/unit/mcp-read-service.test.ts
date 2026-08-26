import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '@/lib/db';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
} from '@/lib/catalog-events/visibility';
import { getRecordingCapability } from '@/lib/access/capabilities';
import {
  getMcpEvent,
  getMcpRecording,
  listMcpEvents,
} from '@/lib/mcp/read-service';

vi.mock('@/lib/db', () => ({
  default: {
    catalogEvent: { findMany: vi.fn(), findFirst: vi.fn() },
    catalogEventRecording: { findMany: vi.fn(), count: vi.fn() },
    catalogEntry: { findMany: vi.fn() },
    audioMetadata: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/access/capabilities', () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock('@/lib/catalog-events/visibility', () => ({
  getPublishedAccessibleRecordingHashes: vi.fn(),
  getPublishedVisibleEventIds: vi.fn(),
  isPublishedVisibleEvent: vi.fn(),
}));

vi.mock('@/lib/mcp/config', () => ({
  getMcpResourceUrl: () => 'https://besedy.example/api/mcp',
}));

vi.mock('@/app/api/catalogs/[id]/search/search-service', () => ({
  executeCatalogSearch: vi.fn(),
}));

describe('MCP read service', () => {
  const db = prisma as unknown as {
    catalogEvent: {
      findMany: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
    catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    audioMetadata: { findMany: ReturnType<typeof vi.fn> };
    catalogEventRecording: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPublishedVisibleEventIds).mockResolvedValue([42]);
    vi.mocked(getPublishedAccessibleRecordingHashes).mockResolvedValue(
      new Set(['visible-recording']),
    );
    vi.mocked(getRecordingCapability).mockResolvedValue({
      canAccessRecording: true,
      catalogGrant: 'VIEWER',
    } as Awaited<ReturnType<typeof getRecordingCapability>>);
    db.catalogEvent.findMany.mockResolvedValue([
      {
        id: 42,
        title: 'Visible event',
        description: 'A searchable subject appears here',
        dateYear: 2026,
        dateMonth: 8,
        dateDay: 26,
        sessionIndex: 1,
        location: { id: 7, name: 'Prague' },
        released: true,
        recordings: [
          {
            audioHash: 'visible-recording',
            isPrimary: true,
            sortOrder: 0,
          },
          {
            audioHash: 'hidden-recording',
            isPrimary: false,
            sortOrder: 1,
          },
        ],
        updatedAt: new Date('2026-08-26T10:00:00.000Z'),
      },
    ]);
    db.catalogEvent.findFirst.mockResolvedValue({
      id: 42,
      title: 'Visible event',
      description: 'A searchable subject appears here',
      dateYear: 2026,
      dateMonth: 8,
      dateDay: 26,
      sessionIndex: 1,
      location: { id: 7, name: 'Prague' },
      released: true,
      recordings: [
        {
          audioHash: 'visible-recording',
          isPrimary: true,
          sortOrder: 0,
        },
        {
          audioHash: 'hidden-recording',
          isPrimary: false,
          sortOrder: 1,
        },
      ],
      createdAt: new Date('2026-08-25T10:00:00.000Z'),
      updatedAt: new Date('2026-08-26T10:00:00.000Z'),
    });
    db.catalogEntry.findMany.mockResolvedValue([
      {
        audioHash: 'visible-recording',
        durationHms: '00:42:00',
        sourceTitle: 'Source title',
        sourceArtist: 'Source artist',
        sourceAlbum: null,
        sourceDate: null,
        isActionable: true,
        isPublished: true,
      },
    ]);
    db.audioMetadata.findMany.mockResolvedValue([
      {
        audioHash: 'visible-recording',
        title: 'Recording title',
        artist: 'Speaker',
        verified: true,
        dateYear: 2026,
        dateMonth: 8,
        dateDay: 26,
        notes: 'Detailed notes must stay out of event lists',
        tags: ['tag'],
        album: { id: 2, name: 'Album' },
        recorder: { id: 3, name: 'Recorder' },
        location: { id: 7, name: 'Prague' },
      },
    ]);
    db.catalogEventRecording.findMany.mockResolvedValue([
      {
        isPrimary: true,
        event: {
          id: 42,
          title: 'Visible event',
          released: true,
          dateYear: 2026,
          dateMonth: 8,
          dateDay: 26,
        },
      },
    ]);
    db.catalogEventRecording.count.mockResolvedValue(2);
  });

  it('filters listener counts, searches descriptions, and returns compact links', async () => {
    const result = await listMcpEvents('catalog-a', 'LISTENER', {
      limit: 25,
      query: 'subject',
    });

    expect(db.catalogEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              description: {
                contains: 'subject',
                mode: 'insensitive',
              },
            },
          ]),
        }),
      }),
    );
    expect(getPublishedAccessibleRecordingHashes).toHaveBeenCalledWith(
      prisma,
      'catalog-a',
      ['visible-recording', 'hidden-recording'],
    );
    expect(result).toEqual({
      catalogId: 'catalog-a',
      events: [
        {
          id: 42,
          webUrl: 'https://besedy.example/catalog/catalog-a/event/42',
          title: 'Visible event',
          description: 'A searchable subject appears here',
          date: { year: 2026, month: 8, day: 26 },
          sessionIndex: 1,
          location: { id: 7, name: 'Prague' },
          released: true,
          recordingCount: 1,
          primaryRecording: {
            audioHash: 'visible-recording',
            title: 'Recording title',
            artist: 'Speaker',
            durationHms: '00:42:00',
            ready: true,
            published: true,
          },
          updatedAt: '2026-08-26T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('returns a bounded page of compact recording summaries and links', async () => {
    const result = await getMcpEvent('catalog-a', 42, 'VIEWER', {
      offset: 0,
      limit: 1,
    });

    expect(db.catalogEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: 'catalog-a',
          audioHash: { in: ['visible-recording'] },
        },
      }),
    );
    expect(result).toMatchObject({
      catalogId: 'catalog-a',
      event: {
        id: 42,
        webUrl: 'https://besedy.example/catalog/catalog-a/event/42',
        recordings: {
          items: [
            {
              audioHash: 'visible-recording',
              title: 'Recording title',
              artist: 'Speaker',
              durationHms: '00:42:00',
              ready: true,
              published: true,
              webUrl:
                'https://besedy.example/catalog/catalog-a/recording/visible-recording',
              isPrimary: true,
              sortOrder: 0,
            },
          ],
          totalVisible: 2,
          nextOffset: 1,
        },
      },
    });
  });

  it('returns detailed recording metadata with a bounded visible event page', async () => {
    const result = await getMcpRecording(
      'user-1',
      'catalog-a',
      'visible-recording',
      { offset: 0, limit: 1 },
    );

    expect(db.catalogEventRecording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: 'catalog-a',
          audioHash: 'visible-recording',
        },
        skip: 0,
        take: 1,
      }),
    );
    expect(result).toMatchObject({
      catalogId: 'catalog-a',
      recording: {
        audioHash: 'visible-recording',
        title: 'Recording title',
        notes: 'Detailed notes must stay out of event lists',
        tags: ['tag'],
        webUrl:
          'https://besedy.example/catalog/catalog-a/recording/visible-recording',
      },
      events: {
        items: [
          {
            id: 42,
            webUrl: 'https://besedy.example/catalog/catalog-a/event/42',
            title: 'Visible event',
            released: true,
            date: { year: 2026, month: 8, day: 26 },
            isPrimary: true,
          },
        ],
        totalVisible: 2,
        nextOffset: 1,
      },
    });
  });

  it('scopes linked event pagination and totals for listeners', async () => {
    vi.mocked(getRecordingCapability).mockResolvedValue({
      canAccessRecording: true,
      catalogGrant: 'LISTENER',
    } as Awaited<ReturnType<typeof getRecordingCapability>>);
    db.catalogEventRecording.count.mockResolvedValue(1);

    const result = await getMcpRecording(
      'listener-1',
      'catalog-a',
      'visible-recording',
      { offset: 0, limit: 25 },
    );

    const permissionScopedWhere = {
      workflowGroupId: 'catalog-a',
      audioHash: 'visible-recording',
      eventId: { in: [42] },
    };
    expect(db.catalogEventRecording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: permissionScopedWhere }),
    );
    expect(db.catalogEventRecording.count).toHaveBeenCalledWith({
      where: permissionScopedWhere,
    });
    expect(result.events.totalVisible).toBe(1);
  });
});
