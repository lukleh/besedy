import { z } from "zod";

/** Longest comment a listener can attach to a bookmark. */
export const BOOKMARK_COMMENT_MAX_LENGTH = 2000;
/** Longest transcript excerpt stored with a bookmark. */
export const BOOKMARK_EXCERPT_MAX_LENGTH = 500;

const MAX_POSITION_SEC = 60 * 60 * 24 * 30;

/** Blank text is stored as no text. */
function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .nullish()
    .transform((value) => (value ? value : null));
}

export const createBookmarkBodySchema = z.object({
  positionSec: z.number().finite().min(0).max(MAX_POSITION_SEC),
  comment: optionalText(BOOKMARK_COMMENT_MAX_LENGTH),
  excerpt: optionalText(BOOKMARK_EXCERPT_MAX_LENGTH),
});

export const updateBookmarkBodySchema = z.object({
  comment: optionalText(BOOKMARK_COMMENT_MAX_LENGTH),
});

export const BookmarkIdParamSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{20,40}$/, "Invalid bookmark ID"),
});

export const recordingBookmarkSchema = z.object({
  id: z.string(),
  positionSec: z.number(),
  comment: z.string().nullable(),
  excerpt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type RecordingBookmark = z.infer<typeof recordingBookmarkSchema>;

export const recordingBookmarksResponseSchema = z.object({
  bookmarks: z.array(recordingBookmarkSchema),
});

/** What the bookmarks page shows of the recording a bookmark points into. */
export const bookmarkRecordingSchema = z.object({
  catalogId: z.string(),
  catalogLabel: z.string().nullable(),
  audioHash: z.string(),
  /** Curated title; leads the heading. */
  title: z.string().nullable(),
  /** Source-file title or filename, for a recording with no heading parts. */
  fallbackTitle: z.string().nullable(),
  dateYear: z.number().nullable(),
  dateMonth: z.number().nullable(),
  dateDay: z.number().nullable(),
  locationName: z.string().nullable(),
  /** The event whose primary recording this is, when the listener can open it. */
  eventId: z.number().nullable(),
});

export type BookmarkRecording = z.infer<typeof bookmarkRecordingSchema>;

export const userBookmarkSchema = recordingBookmarkSchema.extend({
  recording: bookmarkRecordingSchema,
});

export type UserBookmark = z.infer<typeof userBookmarkSchema>;

export const userBookmarksResponseSchema = z.object({
  bookmarks: z.array(userBookmarkSchema),
});

/** The columns a bookmark is read with; `serializeBookmark` turns them into the API shape. */
export const bookmarkSelect = {
  id: true,
  positionSec: true,
  comment: true,
  excerpt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface BookmarkRow {
  id: string;
  positionSec: number;
  comment: string | null;
  excerpt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeBookmark(row: BookmarkRow): RecordingBookmark {
  return {
    id: row.id,
    positionSec: row.positionSec,
    comment: row.comment,
    excerpt: row.excerpt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The page a bookmarked recording opens on: its event when it has one, else the recording. */
export function buildBookmarkRecordingPath(recording: BookmarkRecording): string {
  return recording.eventId !== null
    ? `/catalog/${recording.catalogId}/event/${recording.eventId}`
    : `/catalog/${recording.catalogId}/recording/${recording.audioHash}`;
}

/** That page, starting playback at the bookmark. */
export function buildBookmarkHref(recording: BookmarkRecording, positionSec: number): string {
  return `${buildBookmarkRecordingPath(recording)}?seek=${Math.floor(positionSec)}`;
}
