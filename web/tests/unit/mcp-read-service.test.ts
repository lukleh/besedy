import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '@/lib/db';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
} from '@/lib/catalog-events/visibility';
import { getRecordingCapability } from '@/lib/access/capabilities';
import { getAvailableTranscripts, loadTranscript } from '@/lib/transcript';
import { executeCatalogSearch } from '@/app/api/catalogs/[id]/search/search-service';
import { RagServiceError } from '@/app/api/catalogs/[id]/search/search-route-helpers';
import {
  getMcpEvent,
  getMcpRecording,
  getMcpTranscript,
  listMcpEvents,
  searchMcpTranscripts,
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

vi.mock('@/lib/transcript', () => ({
  getAvailableTranscripts: vi.fn(),
  loadTranscript: vi.fn(),
}));

vi.mock('@/lib/transcript-priority', () => ({
  listTranscriptBackendPriorities: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/paths', () => ({
  resolveTranscriptsPath: vi.fn().mockReturnValue('/transcripts/catalog-a'),
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
      canViewRecordingTranscripts: true,
      catalogGrant: 'VIEWER',
    } as Awaited<ReturnType<typeof getRecordingCapability>>);
    vi.mocked(getAvailableTranscripts).mockResolvedValue({
      hash: 'visible-recording',
      backends: ['whisperx/model'],
    });
    vi.mocked(loadTranscript).mockResolvedValue({
      hash: 'visible-recording',
      backend: 'whisperx/model',
      language: 'cs',
      duration: 20,
      segments: [
        { id: 10, text: 'before', start: 0, end: 5 },
        {
          id: 11,
          text: 'a'.repeat(700),
          start: 5,
          end: 10,
          speaker: 'SPEAKER_00',
        },
        {
          id: 12,
          text: 'b'.repeat(700),
          start: 10,
          end: 15,
          speaker: 'SPEAKER_01',
        },
        { id: 13, text: 'after', start: 15, end: 20 },
      ],
    });
    vi.mocked(executeCatalogSearch).mockResolvedValue({
      query: 'search phrase',
      results: [
        {
          rank: 1,
          audioHash: 'visible-recording',
          chunkId: 'chunk-1',
          score: 0.91,
          startSec: 60,
          endSec: 90,
          text: 'Matching evidence',
          contextText: 'Context before\n\nMatching evidence',
          contextStartSec: 30,
          contextEndSec: 90,
          neighbors: {
            before: [
              {
                chunkId: 'chunk-0',
                audioHash: 'visible-recording',
                startSec: 30,
                endSec: 60,
                text: 'Context before',
              },
            ],
            after: [],
          },
          metadata: {
            date: { year: 2026, month: 8, day: 26 },
            location: { id: 7, name: 'Prague' },
            recorder: { id: 3, name: 'Recorder' },
          },
          citation: {
            audioHash: 'visible-recording',
            chunkId: 'chunk-1',
            startSec: 60,
            endSec: 90,
            workflowGroupId: 'catalog-a',
            backendKey: 'whisperx/model',
            chunkVersion: 'v1',
          },
          provenance: {
            workflowGroupId: 'catalog-a',
            backendKey: 'whisperx/model',
            runId: 'run-1',
            chunkVersion: 'v1',
            embeddingModel: 'colbert',
            embeddingModelVersion: '1',
          },
        },
      ],
    } as unknown as Awaited<ReturnType<typeof executeCatalogSearch>>);
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

  it('returns a half-open time range bounded by transcript text size', async () => {
    const result = await getMcpTranscript(
      'user-1',
      'catalog-a',
      'visible-recording',
      {
        backend: 'whisperx/model',
        startSec: 5,
        endSec: 15,
        segmentOffset: 0,
        segmentLimit: 50,
        maxTextChars: 1_000,
      },
    );

    expect(result).toMatchObject({
      catalogId: 'catalog-a',
      audioHash: 'visible-recording',
      recordingWebUrl:
        'https://besedy.example/catalog/catalog-a/recording/visible-recording',
      backend: 'whisperx/model',
      availableBackends: ['whisperx/model'],
      language: 'cs',
      durationSec: 20,
      timeWindow: { startSec: 5, endSec: 15 },
      segments: {
        items: [
          {
            segmentIndex: 1,
            id: 11,
            text: 'a'.repeat(700),
            startSec: 5,
            endSec: 10,
            speaker: 'SPEAKER_00',
          },
        ],
        offset: 0,
        limit: 50,
        maxTextChars: 1_000,
        returnedTextChars: 700,
        totalMatching: 2,
        nextOffset: 1,
      },
      continuation: {
        catalogId: 'catalog-a',
        audioHash: 'visible-recording',
        backend: 'whisperx/model',
        startSec: 5,
        endSec: 15,
        segmentOffset: 1,
        segmentLimit: 50,
        maxTextChars: 1_000,
      },
    });
  });

  it('returns compact grounded search matches with seekable recording links', async () => {
    const filters = { dateYears: [2026], verified: true };
    const result = await searchMcpTranscripts('catalog-a', 'VIEWER', {
      query: 'search phrase',
      limit: 10,
      contextChunks: 1,
      maxPerRecording: 2,
      filters,
    });

    expect(executeCatalogSearch).toHaveBeenCalledWith({
      catalogId: 'catalog-a',
      query: 'search phrase',
      limit: 10,
      includeNeighbors: true,
      neighborCount: 1,
      maxPerAudio: 2,
      metadataFilters: filters,
      accessLevel: 'VIEWER',
      failOnMissingBundle: true,
    });
    expect(result).toEqual({
      catalogId: 'catalog-a',
      query: 'search phrase',
      retrieval: {
        mode: 'semantic',
        exhaustive: false,
        requestedLimit: 10,
        returnedCount: 1,
        maxPerRecording: 2,
      },
      results: [
        {
          rank: 1,
          score: 0.91,
          recording: {
            audioHash: 'visible-recording',
            title: 'Recording title',
            artist: 'Speaker',
            durationHms: '00:42:00',
            ready: true,
            published: true,
            webUrl:
              'https://besedy.example/catalog/catalog-a/recording/visible-recording',
          },
          match: {
            chunkId: 'chunk-1',
            startSec: 60,
            endSec: 90,
            text: 'Matching evidence',
            webUrl:
              'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=60',
          },
          context: {
            startSec: 30,
            endSec: 90,
            beforeText: 'Context before',
            afterText: null,
          },
          metadata: {
            date: { year: 2026, month: 8, day: 26 },
            location: { id: 7, name: 'Prague' },
            recorder: { id: 3, name: 'Recorder' },
          },
          citation: {
            audioHash: 'visible-recording',
            chunkId: 'chunk-1',
            startSec: 60,
            endSec: 90,
            workflowGroupId: 'catalog-a',
            backendKey: 'whisperx/model',
            chunkVersion: 'v1',
          },
          transcriptRequest: {
            catalogId: 'catalog-a',
            audioHash: 'visible-recording',
            backend: 'whisperx/model',
            startSec: 30,
            endSec: 90,
          },
        },
      ],
    });
  });

  it('returns a structured error when transcript search is unavailable', async () => {
    vi.mocked(executeCatalogSearch).mockRejectedValue(
      new RagServiceError('Model service request failed', 502),
    );

    await expect(
      searchMcpTranscripts('catalog-a', 'VIEWER', {
        query: 'search phrase',
        limit: 10,
        contextChunks: 0,
        maxPerRecording: 3,
      }),
    ).rejects.toMatchObject({
      code: 'search_unavailable',
      message: 'Transcript search is temporarily unavailable',
    });
  });
});
