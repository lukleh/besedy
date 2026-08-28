import { z } from 'zod';
import { LexicalMatchModeSchema } from '@/app/api/catalogs/[id]/search/search-route-helpers';
import {
  AccessLevelSchema,
  HashSchema,
  TranscriptBackendSchema,
  UserStatusSchema,
} from '@/lib/validation/schemas';

const CatalogIdSchema = z
  .string()
  .describe('Stable ID of the Besedy catalog that produced this result.');
const WebUrlSchema = z
  .string()
  .url()
  .describe('Authenticated Besedy web URL for this source.');
const NullableCursorSchema = z
  .string()
  .nullable()
  .describe('Opaque continuation cursor, or null when the list is complete.');
const NullableOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .nullable()
  .describe('Offset for the next page, or null when the page is complete.');
const NamedEntitySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
});
const EventDateSchema = z.object({
  year: z.number().int(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
});
const RecordingDateSchema = z.object({
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  day: z.number().int().nullable(),
});
const RecordingSummarySchema = z.object({
  audioHash: HashSchema.describe('Stable SHA-256 recording identifier.'),
  title: z.string(),
  artist: z.string().nullable(),
  durationHms: z.string().nullable(),
  ready: z.boolean(),
  published: z.boolean(),
  webUrl: WebUrlSchema,
});
const CompactEventSchema = z.object({
  id: z.number().int().positive(),
  webUrl: WebUrlSchema,
  title: z.string().nullable(),
  released: z.boolean(),
  date: EventDateSchema,
  isPrimary: z.boolean(),
});

export const WhoAmIOutputSchema = z.object({
  account: z.object({
    id: z.string().describe('Stable authenticated Besedy user ID.'),
    name: z.string().nullable(),
    email: z.string().nullable(),
    emailVerified: z.boolean().nullable(),
    status: UserStatusSchema.nullable(),
    systemRole: z.enum(['USER', 'ADMIN', 'SUPERADMIN']).nullable(),
  }),
  authorization: z.object({
    clientId: z.string(),
    clientName: z.string().nullable(),
    grantedScopes: z.array(z.string()),
    accessibleCatalogCount: z.number().int().nonnegative(),
    defaultCatalogId: CatalogIdSchema.nullable(),
  }),
});

const CatalogCapabilitiesSchema = z.object({
  canListEvents: z.boolean(),
  canGetRecordings: z.boolean(),
  canViewTranscripts: z.boolean(),
  canSearchTranscripts: z.boolean(),
  canSeeUnreleasedEvents: z.boolean(),
});

export const ListCatalogsOutputSchema = z.object({
  catalogs: z.array(
    z.object({
      id: CatalogIdSchema,
      label: z.string().nullable(),
      isUserDefault: z.boolean(),
      isGlobalDefault: z.boolean(),
      isEffectiveDefault: z.boolean(),
      catalogGrant: AccessLevelSchema.nullable(),
      isCatalogAdmin: z.boolean(),
      capabilities: CatalogCapabilitiesSchema.describe(
        'Per-catalog capabilities that determine which other tools can be used.',
      ),
    }),
  ),
  defaultCatalogId: CatalogIdSchema.nullable(),
  defaultCatalogSource: z
    .enum(['user_preference', 'global_default', 'most_recent'])
    .nullable(),
  nextCursor: NullableCursorSchema,
});

export const ListLocationsOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  locations: z.array(
    NamedEntitySchema.extend({
      eventCount: z.number().int().nonnegative().nullable(),
      recordingCount: z.number().int().nonnegative(),
    }),
  ),
  nextCursor: NullableCursorSchema,
});

export const ListRecordersOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  recorders: z.array(
    NamedEntitySchema.extend({
      recordingCount: z.number().int().nonnegative(),
    }),
  ),
  nextCursor: NullableCursorSchema,
});

export const ListEventsOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  events: z.array(
    z.object({
      id: z.number().int().positive(),
      webUrl: WebUrlSchema,
      title: z.string().nullable(),
      description: z.string().nullable(),
      date: EventDateSchema,
      sessionIndex: z.number().int().positive(),
      location: NamedEntitySchema,
      released: z.boolean(),
      recordings: z.object({
        primaryAudioHash: HashSchema.nullable(),
        audioHashes: z.array(HashSchema),
      }),
      updatedAt: z.string().datetime(),
    }),
  ),
  nextCursor: NullableCursorSchema,
});

export const GetEventOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  event: z.object({
    id: z.number().int().positive(),
    webUrl: WebUrlSchema,
    title: z.string().nullable(),
    description: z.string().nullable(),
    date: EventDateSchema,
    sessionIndex: z.number().int().positive(),
    location: NamedEntitySchema,
    released: z.boolean(),
    recordings: z.object({
      items: z.array(
        RecordingSummarySchema.extend({
          isPrimary: z.boolean(),
          sortOrder: z.number().int(),
        }),
      ),
      totalVisible: z.number().int().nonnegative(),
      nextOffset: NullableOffsetSchema,
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
});

export const GetRecordingOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  recording: RecordingSummarySchema.extend({
    album: z
      .object({ id: z.number().int().positive().nullable(), name: z.string() })
      .nullable(),
    sourceDate: z.string().nullable(),
    date: RecordingDateSchema,
    location: NamedEntitySchema.nullable(),
    recorder: NamedEntitySchema.nullable(),
    verified: z.boolean(),
    notes: z.string().nullable(),
    tags: z.array(z.string()),
  }),
  events: z.object({
    items: z.array(CompactEventSchema),
    totalVisible: z.number().int().nonnegative(),
    nextOffset: NullableOffsetSchema,
  }),
});

const TranscriptContinuationSchema = z.object({
  catalogId: CatalogIdSchema,
  audioHash: HashSchema,
  backend: TranscriptBackendSchema,
  mode: z.literal('page'),
  startSec: z.number().nonnegative().optional(),
  endSec: z.number().positive().optional(),
  segmentOffset: z.number().int().nonnegative(),
  segmentLimit: z.number().int().positive(),
  maxTextChars: z.number().int().positive(),
});

export const GetTranscriptOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  audioHash: HashSchema,
  recordingWebUrl: WebUrlSchema.describe(
    'Unbounded recording page URL without a stop time.',
  ),
  seekWebUrl: WebUrlSchema.nullable().describe(
    'Bounded link for the first returned segment, or null for an empty page.',
  ),
  backend: TranscriptBackendSchema,
  availableBackends: z.array(TranscriptBackendSchema),
  language: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  mode: z.enum(['full', 'page']),
  timeWindow: z.object({
    startSec: z.number().nonnegative().nullable(),
    endSec: z.number().positive().nullable(),
  }),
  segments: z.object({
    items: z.array(
      z.object({
        segmentIndex: z.number().int().nonnegative(),
        id: z.number().int().nullable(),
        text: z.string(),
        startSec: z.number().nonnegative(),
        endSec: z.number().nonnegative(),
        speaker: z.string().nullable(),
        webUrl: WebUrlSchema.describe(
          'Bounded source link that seeks to this segment and stops at its end.',
        ),
      }),
    ),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    maxTextChars: z.number().int().positive().nullable(),
    returnedTextChars: z.number().int().nonnegative(),
    totalMatching: z.number().int().nonnegative(),
    nextOffset: NullableOffsetSchema,
  }),
  continuation: TranscriptContinuationSchema.nullable().describe(
    'Arguments for the next page, or null when no more matching segments remain.',
  ),
});

const TranscriptSearchResultSchema = z.object({
  rank: z.number().int().positive(),
  recording: RecordingSummarySchema,
  match: z.object({
    chunkId: z.string(),
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    text: z.string(),
    webUrl: WebUrlSchema.describe(
      'Bounded source link for the exact transcript-search match.',
    ),
  }),
  context: z
    .object({
      startSec: z.number().nonnegative(),
      endSec: z.number().nonnegative(),
      beforeText: z.string().nullable(),
      afterText: z.string().nullable(),
    })
    .nullable(),
  metadata: z.object({
    date: RecordingDateSchema,
    location: NamedEntitySchema.nullable(),
    recorder: NamedEntitySchema.nullable(),
  }),
  citation: z.object({
    audioHash: HashSchema,
    chunkId: z.string(),
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    workflowGroupId: CatalogIdSchema,
    backendKey: z.string(),
    chunkVersion: z.string(),
  }),
  transcriptRequest: z
    .object({
      catalogId: CatalogIdSchema,
      audioHash: HashSchema,
      backend: TranscriptBackendSchema,
      mode: z.literal('page'),
      startSec: z.number().nonnegative(),
      endSec: z.number().nonnegative(),
    })
    .nullable()
    .describe(
      'Ready-to-call get_transcript arguments for verifying this candidate in continuous context.',
    ),
});

export const SearchTranscriptsOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  query: z.string(),
  retrieval: z.object({
    mode: z.literal('semantic'),
    exhaustive: z.literal(false),
    requestedLimit: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    maxPerRecording: z.number().int().positive(),
  }),
  results: z.array(TranscriptSearchResultSchema),
});

export const FindTranscriptMentionsOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  query: z.string(),
  retrieval: z.object({
    mode: z.literal('lexical'),
    matchMode: LexicalMatchModeSchema,
    corpusCoverage: z.literal('complete'),
    totalMatches: z.number().int().nonnegative(),
    requestedLimit: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    maxPerRecording: z.number().int().positive(),
  }),
  results: z.array(TranscriptSearchResultSchema),
});
