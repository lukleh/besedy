import { beforeEach, describe, expect, it, vi } from 'vitest';
import prisma from '@/lib/db';
import {
  getPublishedAccessibleRecordingHashes,
  getPublishedVisibleEventIds,
  isPublishedVisibleEvent,
} from '@/lib/catalog-events/visibility';
import { getAvailableTranscripts, loadTranscript } from '@/lib/transcript';
import {
  executeCatalogLexicalSearch,
  executeCatalogSearch,
} from '@/app/api/catalogs/[id]/search/search-service';
import { RagServiceError } from '@/app/api/catalogs/[id]/search/search-route-helpers';
import {
  getMcpEvent,
  findMcpTranscriptMentions,
  getMcpRecording,
  getMcpTranscript,
  listMcpLocations,
  listMcpRecorders,
  listMcpEvents,
  searchMcpTranscripts,
} from '@/lib/mcp/read-service';

vi.mock('@/lib/db', () => ({
  default: {
    catalogEvent: { findMany: vi.fn(), findFirst: vi.fn() },
    catalogEventRecording: { findMany: vi.fn(), count: vi.fn() },
    catalogEntry: { findMany: vi.fn() },
    audioMetadata: { findMany: vi.fn() },
    location: { findMany: vi.fn() },
    recorder: { findMany: vi.fn() },
  },
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
  executeCatalogLexicalSearch: vi.fn(),
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
    location: { findMany: ReturnType<typeof vi.fn> };
    recorder: { findMany: ReturnType<typeof vi.fn> };
    catalogEventRecording: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPublishedVisibleEventIds).mockResolvedValue([42]);
    vi.mocked(isPublishedVisibleEvent).mockResolvedValue(true);
    vi.mocked(getPublishedAccessibleRecordingHashes).mockResolvedValue(
      new Set(['visible-recording']),
    );
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
            backendKey: 'whisperx/model@lang-auto',
            chunkVersion: 'v1',
          },
          provenance: {
            workflowGroupId: 'catalog-a',
            backendKey: 'whisperx/model@lang-auto',
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

  it('filters events by partial date and location and returns visible hashes', async () => {
    const result = await listMcpEvents('catalog-a', {
      limit: 25,
      order: 'desc',
      query: 'subject',
      date: { year: 2026, month: 8 },
      locationId: 7,
    });

    expect(db.catalogEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dateYear: 2026,
          dateMonth: 8,
          locationId: 7,
          OR: expect.arrayContaining([
            {
              description: {
                contains: 'subject',
                mode: 'insensitive',
              },
            },
          ]),
        }),
        orderBy: [
          { dateYear: 'desc' },
          { dateMonth: { sort: 'desc', nulls: 'last' } },
          { dateDay: { sort: 'desc', nulls: 'last' } },
          { sessionIndex: 'desc' },
          { id: 'desc' },
        ],
      }),
    );
    expect(getPublishedAccessibleRecordingHashes).toHaveBeenCalledWith(
      prisma,
      'catalog-a',
      ['visible-recording', 'hidden-recording'],
    );
    expect(db.catalogEntry.findMany).not.toHaveBeenCalled();
    expect(db.audioMetadata.findMany).not.toHaveBeenCalled();
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
          recordings: {
            primaryAudioHash: 'visible-recording',
            audioHashes: ['visible-recording'],
          },
          updatedAt: '2026-08-26T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('lists only visible location and recorder IDs with catalog-scoped counts', async () => {
    db.audioMetadata.findMany.mockResolvedValue([
      {
        audioHash: 'visible-recording',
        locationId: 7,
        recorderId: 3,
      },
      {
        audioHash: 'hidden-recording',
        locationId: 8,
        recorderId: 4,
      },
    ]);
    db.catalogEvent.findMany.mockResolvedValue([
      { locationId: 7 },
      { locationId: 9 },
    ]);
    db.location.findMany.mockResolvedValue([
      { id: 9, name: 'Vienna' },
      { id: 7, name: 'Prague' },
    ]);
    db.recorder.findMany.mockResolvedValue([{ id: 3, name: 'Petr' }]);

    const locations = await listMcpLocations('catalog-a', {
      limit: 1,
    });

    expect(db.audioMetadata.findMany).toHaveBeenCalledWith({
      where: { workflowGroupId: 'catalog-a', locationId: { not: null } },
      select: { audioHash: true, locationId: true },
    });
    expect(db.catalogEvent.findMany).toHaveBeenCalledWith({
      where: { workflowGroupId: 'catalog-a', id: { in: [42] } },
      select: { locationId: true },
    });
    expect(db.location.findMany).toHaveBeenCalledWith({
      where: { id: { in: [7, 9] } },
      select: { id: true, name: true },
    });
    expect(locations).toMatchObject({
      catalogId: 'catalog-a',
      locations: [{ id: 7, name: 'Prague', eventCount: 1, recordingCount: 1 }],
      nextCursor: expect.any(String),
    });

    const nextLocations = await listMcpLocations('catalog-a', {
      cursor: locations.nextCursor!,
      limit: 1,
    });
    expect(nextLocations).toEqual({
      catalogId: 'catalog-a',
      locations: [{ id: 9, name: 'Vienna', eventCount: 1, recordingCount: 0 }],
      nextCursor: null,
    });
    await expect(
      listMcpLocations('catalog-a', {
        cursor: locations.nextCursor!,
        limit: 1,
        query: 'Vienna',
      }),
    ).rejects.toMatchObject({ code: 'invalid_cursor', retryable: false });

    const recorders = await listMcpRecorders('catalog-a', {
      limit: 50,
      query: 'pet',
    });
    expect(db.recorder.findMany).toHaveBeenCalledWith({
      where: { id: { in: [3] } },
      select: { id: true, name: true },
    });
    expect(db.audioMetadata.findMany).toHaveBeenLastCalledWith({
      where: { workflowGroupId: 'catalog-a', recorderId: { not: null } },
      select: { audioHash: true, recorderId: true },
    });
    expect(recorders).toEqual({
      catalogId: 'catalog-a',
      recorders: [{ id: 3, name: 'Petr', recordingCount: 1 }],
      nextCursor: null,
    });
  });

  it('includes locations from released events', async () => {
    db.audioMetadata.findMany.mockResolvedValue([
      {
        audioHash: 'visible-recording',
        locationId: 7,
        recorderId: null,
      },
    ]);
    db.location.findMany.mockResolvedValue([{ id: 7, name: 'Prague' }]);
    db.catalogEvent.findMany.mockResolvedValue([{ locationId: 7 }]);

    const result = await listMcpLocations('catalog-a', {
      limit: 50,
    });

    expect(db.catalogEvent.findMany).toHaveBeenCalled();
    expect(result.locations).toEqual([
      {
        id: 7,
        name: 'Prague',
        eventCount: 1,
        recordingCount: 1,
      },
    ]);
  });

  it('excludes recordings outside listener visibility from lookups', async () => {
    db.audioMetadata.findMany.mockResolvedValue([
      {
        audioHash: 'visible-recording',
        locationId: 7,
        recorderId: 3,
      },
      {
        audioHash: 'orphaned-recording',
        locationId: 8,
        recorderId: 4,
      },
    ]);
    db.location.findMany.mockResolvedValue([{ id: 7, name: 'Prague' }]);
    db.recorder.findMany.mockResolvedValue([{ id: 3, name: 'Petr' }]);

    const locations = await listMcpLocations('catalog-a', { limit: 50 });
    const recorders = await listMcpRecorders('catalog-a', {
      limit: 50,
    });

    expect(getPublishedAccessibleRecordingHashes).toHaveBeenCalledWith(
      prisma,
      'catalog-a',
      ['visible-recording', 'orphaned-recording'],
    );
    expect(locations.locations).toEqual([
      {
        id: 7,
        name: 'Prague',
        eventCount: 0,
        recordingCount: 1,
      },
    ]);
    expect(recorders.recorders).toEqual([
      { id: 3, name: 'Petr', recordingCount: 1 },
    ]);
  });

  it('treats event query metacharacters as literal text', async () => {
    await listMcpEvents('catalog-a', {
      limit: 25,
      order: 'desc',
      query: String.raw`100%_done\today`,
    });

    expect(db.catalogEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              title: {
                contains: String.raw`100\%\_done\\today`,
                mode: 'insensitive',
              },
            },
          ]),
        }),
      }),
    );
  });

  it('paginates ascending event dates with an opaque cursor', async () => {
    const event = {
      id: 42,
      title: 'Visible event',
      description: null,
      dateYear: 2026,
      dateMonth: 8,
      dateDay: 26,
      sessionIndex: 1,
      location: { id: 7, name: 'Prague' },
      released: true,
      recordings: [],
      updatedAt: new Date('2026-08-26T10:00:00.000Z'),
    };
    db.catalogEvent.findMany.mockResolvedValueOnce([
      event,
      { ...event, id: 43, sessionIndex: 2 },
    ]);

    const firstPage = await listMcpEvents('catalog-a', {
      limit: 1,
      order: 'asc',
    });

    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(db.catalogEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orderBy: [
          { dateYear: 'asc' },
          { dateMonth: { sort: 'asc', nulls: 'last' } },
          { dateDay: { sort: 'asc', nulls: 'last' } },
          { sessionIndex: 'asc' },
          { id: 'asc' },
        ],
      }),
    );

    db.catalogEvent.findMany.mockResolvedValueOnce([]);
    await listMcpEvents('catalog-a', {
      cursor: firstPage.nextCursor!,
      limit: 1,
      order: 'asc',
    });

    expect(db.catalogEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            expect.objectContaining({
              OR: expect.arrayContaining([
                {
                  AND: [
                    { dateYear: 2026 },
                    { dateMonth: 8 },
                    { dateDay: 26 },
                    { sessionIndex: { gt: 1 } },
                  ],
                },
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it('paginates partial dates without numeric comparisons against nulls', async () => {
    const partialDateEvent = {
      id: 42,
      title: 'Year-only event',
      description: null,
      dateYear: 2026,
      dateMonth: null,
      dateDay: null,
      sessionIndex: 1,
      location: { id: 7, name: 'Prague' },
      released: true,
      recordings: [],
      updatedAt: new Date('2026-08-26T10:00:00.000Z'),
    };
    db.catalogEvent.findMany.mockResolvedValueOnce([
      partialDateEvent,
      { ...partialDateEvent, id: 41 },
    ]);
    const firstPage = await listMcpEvents('catalog-a', {
      limit: 1,
      order: 'desc',
    });

    db.catalogEvent.findMany.mockResolvedValueOnce([]);
    await listMcpEvents('catalog-a', {
      cursor: firstPage.nextCursor!,
      limit: 1,
      order: 'desc',
    });

    expect(db.catalogEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { dateYear: { lt: 2026 } },
                {
                  AND: [
                    { dateYear: 2026 },
                    { dateMonth: null },
                    { dateDay: null },
                    { sessionIndex: { lt: 1 } },
                  ],
                },
                {
                  AND: [
                    { dateYear: 2026 },
                    { dateMonth: null },
                    { dateDay: null },
                    { sessionIndex: 1 },
                    { id: { lt: 42 } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
  });

  it('rejects malformed or mismatched event cursors', async () => {
    await expect(
      listMcpEvents('catalog-a', {
        cursor: 'not-a-cursor',
        limit: 25,
        order: 'desc',
      }),
    ).rejects.toMatchObject({ code: 'invalid_cursor', retryable: false });

    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        catalogId: 'another-catalog',
        order: 'desc',
        dateYear: 2026,
        dateMonth: 8,
        dateDay: 26,
        sessionIndex: 1,
        eventId: 42,
      }),
      'utf8',
    ).toString('base64url');
    await expect(
      listMcpEvents('catalog-a', {
        cursor,
        limit: 25,
        order: 'desc',
      }),
    ).rejects.toMatchObject({ code: 'invalid_cursor', retryable: false });
  });

  it('returns a bounded page of compact recording summaries and links', async () => {
    const result = await getMcpEvent('catalog-a', 42, {
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
          totalVisible: 1,
          nextOffset: null,
        },
      },
    });
  });

  it('returns detailed recording metadata with a bounded visible event page', async () => {
    const result = await getMcpRecording('catalog-a', 'visible-recording', {
      offset: 0,
      limit: 1,
    });

    expect(db.catalogEventRecording.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workflowGroupId: 'catalog-a',
          audioHash: 'visible-recording',
          eventId: { in: [42] },
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

  it('scopes linked event pagination and totals to released events', async () => {
    db.catalogEventRecording.count.mockResolvedValue(1);

    const result = await getMcpRecording('catalog-a', 'visible-recording', {
      offset: 0,
      limit: 25,
    });

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

  it('hides unpublished recordings from metadata and transcript reads', async () => {
    await expect(
      getMcpRecording('catalog-a', 'hidden-recording', {
        offset: 0,
        limit: 25,
      }),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });

    await expect(
      getMcpTranscript('catalog-a', 'hidden-recording', {
        mode: 'page',
        segmentOffset: 0,
        segmentLimit: 50,
        maxTextChars: 20_000,
      }),
    ).rejects.toMatchObject({ code: 'not_found', retryable: false });

    expect(getAvailableTranscripts).not.toHaveBeenCalled();
  });

  it('returns a half-open time range bounded by transcript text size', async () => {
    const result = await getMcpTranscript('catalog-a', 'visible-recording', {
      mode: 'page',
      backend: 'whisperx/model',
      startSec: 5,
      endSec: 15,
      segmentOffset: 0,
      segmentLimit: 50,
      maxTextChars: 1_000,
    });

    expect(result).toMatchObject({
      catalogId: 'catalog-a',
      audioHash: 'visible-recording',
      recordingWebUrl:
        'https://besedy.example/catalog/catalog-a/recording/visible-recording',
      seekWebUrl:
        'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=5&end=10',
      backend: 'whisperx/model',
      availableBackends: ['whisperx/model'],
      language: 'cs',
      durationSec: 20,
      mode: 'page',
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
            webUrl:
              'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=5&end=10',
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
        mode: 'page',
        startSec: 5,
        endSec: 15,
        segmentOffset: 1,
        segmentLimit: 50,
        maxTextChars: 1_000,
      },
    });
  });

  it('returns every matching transcript segment in full mode', async () => {
    const result = await getMcpTranscript('catalog-a', 'visible-recording', {
      mode: 'full',
      startSec: 5,
    });

    expect(result).toMatchObject({
      mode: 'full',
      timeWindow: { startSec: 5, endSec: null },
      segments: {
        offset: 0,
        limit: null,
        maxTextChars: null,
        totalMatching: 3,
        nextOffset: null,
        items: [
          { segmentIndex: 1, text: 'a'.repeat(700) },
          { segmentIndex: 2, text: 'b'.repeat(700) },
          { segmentIndex: 3, text: 'after' },
        ],
      },
      continuation: null,
    });
  });

  it('omits absent time bounds from replayable page continuations', async () => {
    const result = await getMcpTranscript('catalog-a', 'visible-recording', {
      mode: 'page',
      segmentOffset: 0,
      segmentLimit: 2,
      maxTextChars: 1_000,
    });

    expect(result.continuation).toEqual({
      catalogId: 'catalog-a',
      audioHash: 'visible-recording',
      backend: 'whisperx/model',
      mode: 'page',
      segmentOffset: 2,
      segmentLimit: 2,
      maxTextChars: 1_000,
    });
  });

  it('builds seek links from the first segment actually returned after an offset', async () => {
    const result = await getMcpTranscript('catalog-a', 'visible-recording', {
      mode: 'page',
      segmentOffset: 2,
      segmentLimit: 1,
      maxTextChars: 1_000,
    });

    expect(result.seekWebUrl).toBe(
      'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=10&end=15',
    );
    expect(result.segments.items).toEqual([
      expect.objectContaining({
        segmentIndex: 2,
        startSec: 10,
        webUrl:
          'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=10&end=15',
      }),
    ]);
  });

  it('returns a null seek link when the requested transcript page is empty', async () => {
    const result = await getMcpTranscript('catalog-a', 'visible-recording', {
      mode: 'page',
      segmentOffset: 10,
      segmentLimit: 1,
      maxTextChars: 1_000,
    });

    expect(result.seekWebUrl).toBeNull();
    expect(result.segments.items).toEqual([]);
  });

  it('returns compact grounded search matches with seekable recording links', async () => {
    const filters = { eventIds: [42], dateYears: [2026], verified: true };
    const result = await searchMcpTranscripts('catalog-a', {
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
      accessLevel: 'LISTENER',
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
              'https://besedy.example/catalog/catalog-a/recording/visible-recording?seek=60&end=90',
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
            backendKey: 'whisperx/model@lang-auto',
            chunkVersion: 'v1',
          },
          transcriptRequest: {
            catalogId: 'catalog-a',
            audioHash: 'visible-recording',
            backend: 'whisperx/model',
            mode: 'page',
            startSec: 30,
            endSec: 90,
          },
        },
      ],
    });
  });

  it('forwards symmetric filters and reports complete lexical match counts', async () => {
    vi.mocked(executeCatalogLexicalSearch).mockResolvedValue({
      query: 'exact phrase',
      results: [],
      totalMatches: 7,
    } as unknown as Awaited<ReturnType<typeof executeCatalogLexicalSearch>>);
    const filters = { eventIds: [42], dateYears: [2026], verified: true };

    const result = await findMcpTranscriptMentions('catalog-a', {
      query: 'exact phrase',
      matchMode: 'phrase',
      limit: 10,
      contextChunks: 1,
      maxPerRecording: 2,
      filters,
    });

    expect(executeCatalogLexicalSearch).toHaveBeenCalledWith({
      catalogId: 'catalog-a',
      query: 'exact phrase',
      matchMode: 'phrase',
      limit: 10,
      includeNeighbors: true,
      neighborCount: 1,
      maxPerAudio: 2,
      metadataFilters: filters,
      accessLevel: 'LISTENER',
      failOnMissingBundle: true,
    });
    expect(result.retrieval).toEqual({
      mode: 'lexical',
      matchMode: 'phrase',
      corpusCoverage: 'complete',
      totalMatches: 7,
      requestedLimit: 10,
      returnedCount: 0,
      maxPerRecording: 2,
    });
  });

  it('returns a structured error when transcript search is unavailable', async () => {
    vi.mocked(executeCatalogSearch).mockRejectedValue(
      new RagServiceError('Model service request failed', 502),
    );

    await expect(
      searchMcpTranscripts('catalog-a', {
        query: 'search phrase',
        limit: 10,
        contextChunks: 0,
        maxPerRecording: 3,
      }),
    ).rejects.toMatchObject({
      code: 'search_unavailable',
      message: 'Transcript search is temporarily unavailable',
      retryable: true,
    });
  });

  it('returns a non-retryable error when transcript search is not configured', async () => {
    vi.mocked(executeCatalogSearch).mockRejectedValue(
      new RagServiceError('ColBERT bundle not found for catalog', 404),
    );

    await expect(
      searchMcpTranscripts('catalog-a', {
        query: 'search phrase',
        limit: 10,
        contextChunks: 0,
        maxPerRecording: 3,
      }),
    ).rejects.toMatchObject({
      code: 'search_not_configured',
      message: 'Transcript search is not configured for this catalog',
      retryable: false,
    });
  });
});
