import { z } from 'zod';
import { LexicalMatchModeSchema } from '@/app/api/catalogs/[id]/search/search-route-helpers';
import {
  AccessLevelSchema,
  HashSchema,
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
const RecordingMetadataSchema = z.object({
  audioHash: HashSchema.describe('Stable SHA-256 recording identifier.'),
  title: z.string(),
  artist: z.string().nullable(),
  durationHms: z.string().nullable(),
  webUrl: WebUrlSchema,
});
const EventRefSchema = z.object({
  id: z.number().int().positive(),
  webUrl: WebUrlSchema.describe(
    'Authenticated page for the event that provides this result context.',
  ),
  date: EventDateSchema.describe(
    'Authoritative event date; the year is always known while month or day may be unknown.',
  ),
  location: NamedEntitySchema.describe('Authoritative event location.'),
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

export const ListCatalogsOutputSchema = z.object({
  catalogs: z.array(
    z.object({
      id: CatalogIdSchema,
      label: z.string().nullable(),
      isDefault: z.boolean(),
      catalogGrant: AccessLevelSchema.nullable(),
      isCatalogAdmin: z.boolean(),
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
      eventCount: z.number().int().nonnegative(),
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
  events: z.array(EventRefSchema),
  nextCursor: NullableCursorSchema,
});

export const GetEventOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  event: EventRefSchema.extend({
    title: z.string().nullable(),
    description: z.string().nullable(),
    sessionIndex: z.number().int().positive(),
    recordings: z.object({
      items: z.array(
        z.object({
          audioHash: HashSchema.describe(
            'Stable SHA-256 recording identifier.',
          ),
          webUrl: WebUrlSchema,
          isPrimary: z.boolean(),
        }),
      ),
      totalVisible: z.number().int().nonnegative(),
      nextOffset: NullableOffsetSchema,
    }),
  }),
});

export const GetRecordingOutputSchema = z.object({
  catalogId: CatalogIdSchema,
  recording: RecordingMetadataSchema.extend({
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
  event: EventRefSchema.extend({ isPrimary: z.boolean() })
    .nullable()
    .describe(
      'The recording event when it is visible to the caller, otherwise null.',
    ),
});

const TranscriptContinuationSchema = z.object({
  catalogId: CatalogIdSchema,
  audioHash: HashSchema,
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
  language: z.string().nullable(),
  durationSec: z.number().nonnegative().nullable(),
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
    totalMatching: z.number().int().nonnegative(),
  }),
  continuation: TranscriptContinuationSchema.nullable().describe(
    'Arguments for the next page, or null when no more matching segments remain.',
  ),
});

const TranscriptSearchResultSchema = z.object({
  rank: z.number().int().positive(),
  event: EventRefSchema,
  recording: z.object({
    audioHash: HashSchema.describe(
      'Stable SHA-256 identifier of the recording that owns this transcript match.',
    ),
  }),
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
  citation: z.object({
    audioHash: HashSchema,
    chunkId: z.string(),
    startSec: z.number().nonnegative(),
    endSec: z.number().nonnegative(),
    workflowGroupId: CatalogIdSchema,
    chunkVersion: z.string(),
  }),
  transcriptRequest: z
    .object({
      catalogId: CatalogIdSchema,
      audioHash: HashSchema,
      mode: z.literal('page'),
      startSec: z.number().nonnegative(),
      endSec: z.number().nonnegative(),
    })
    .nullable()
    .describe(
      'Ready-to-call get_transcript arguments for verifying this candidate in continuous context, or null when the canonical transcript is unavailable.',
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
    corpusCoverage: z
      .literal('complete')
      .describe(
        'Complete over authorized indexed chunks under the selected filters and match mode.',
      ),
    totalMatches: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Number of matching authorized indexed chunks before returned-result caps; not a count of distinct events.',
      ),
    requestedLimit: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    maxPerRecording: z.number().int().positive(),
  }),
  results: z.array(TranscriptSearchResultSchema),
});
