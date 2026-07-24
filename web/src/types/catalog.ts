/**
 * Frontend types for catalog data display
 */

/**
 * Album reference
 */
export interface AlbumInfo {
  id: number;
  name: string;
}

/**
 * Recorder reference
 */
export interface RecorderInfo {
  id: number;
  name: string;
}

/**
 * Location reference
 */
export interface LocationInfo {
  id: number;
  name: string;
}

/**
 * Enriched catalog entry returned from API
 * Combines CSV data with database curated metadata
 */
export interface CatalogEntryResponse {
  hash: string;
  filename?: string;
  duration?: string;
  title?: string;
  curatedTitle?: string | null;
  artist?: string;
  curatedArtist?: string | null;
  albumId?: number | null;
  album?: AlbumInfo | null;
  date?: string;
  curatedDate?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
  hasArchivedAudio: boolean;
  hasOriginalAudio: boolean;
  curated?: boolean;
  verified?: boolean;
  verifiedAt?: string | null;
  tags?: string[];
  notes?: string | null;
  recorderId?: number | null;
  recorder?: RecorderInfo | null;
  locationId?: number | null;
  location?: LocationInfo | null;
  part?: number | null;
  duplicateCount?: number;
}

interface CatalogEntryDtoSource {
  hash: string;
  compressedPath?: string | null;
  filename?: string | null;
  originalPath?: string | null;
  duration?: string | null;
  title?: string | null;
  curatedTitle?: string | null;
  artist?: string | null;
  curatedArtist?: string | null;
  albumId?: number | null;
  album?: AlbumInfo | null;
  date?: string | null;
  curatedDate?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
  curated?: boolean;
  verified?: boolean;
  verifiedAt?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  recorderId?: number | null;
  recorder?: RecorderInfo | null;
  locationId?: number | null;
  location?: LocationInfo | null;
  part?: number | null;
  duplicateCount?: number | null;
}

export function toCatalogEntryResponse(
  entry: CatalogEntryDtoSource
): CatalogEntryResponse {
  return {
    hash: entry.hash,
    filename: entry.filename ?? undefined,
    duration: entry.duration ?? undefined,
    title: entry.title ?? undefined,
    curatedTitle: entry.curatedTitle ?? null,
    artist: entry.artist ?? undefined,
    curatedArtist: entry.curatedArtist ?? null,
    albumId: entry.albumId ?? null,
    album: entry.album ?? null,
    date: entry.date ?? undefined,
    curatedDate: entry.curatedDate ?? null,
    dateYear: entry.dateYear ?? null,
    dateMonth: entry.dateMonth ?? null,
    dateDay: entry.dateDay ?? null,
    hasArchived: entry.hasArchived,
    hasMetadata: entry.hasMetadata,
    isActionable: entry.isActionable,
    isPublished: entry.isPublished,
    hasArchivedAudio: Boolean(entry.compressedPath),
    hasOriginalAudio: Boolean(entry.originalPath),
    curated: entry.curated,
    verified: entry.verified,
    verifiedAt: entry.verifiedAt ?? null,
    tags: entry.tags ?? [],
    notes: entry.notes ?? null,
    recorderId: entry.recorderId ?? null,
    recorder: entry.recorder ?? null,
    locationId: entry.locationId ?? null,
    location: entry.location ?? null,
    part: entry.part ?? null,
    duplicateCount: entry.duplicateCount ?? 0,
  };
}

/**
 * Response from /api/catalogs/[id]/recordings/[hash]/entry
 */
export interface CatalogEntryWithPermissions {
  entry: CatalogEntryResponse;
  canViewTranscripts: boolean;
  canEditMetadata: boolean;
  canDownload: boolean;
}

/**
 * Response from /api/catalog (list endpoint)
 */
export interface CatalogListResponse {
  groupId: string;
  groupLabel: string | null;
  totalAll?: number;
  total: number;
  actionable: number;
  verified: number;
  entries: CatalogEntryResponse[];
  filters?: {
    parts: number[];
    dateParts: { year: number; month: number | null; day: number | null }[];
  };
  pagination: {
    page: number;
    limit: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
  canManageAccess?: boolean;
  canEditMetadata?: boolean;
  canDownload?: boolean;
}

/**
 * Source metadata fields from CSV (display-only, camelCase)
 */
export interface SourceMetadataFields {
  // File info
  filename?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  fullPath?: string;
  scanRoot?: string;
  status?: string;
  duration?: string;

  // Metadata tags
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encodedBy?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
}

/**
 * Source archived fields from CSV (display-only)
 */
export interface SourceArchivedFields {
  originalPath?: string;
  compressedPath?: string;
  format?: string;
  bitrateKbps?: string;
  originalSizeBytes?: string;
  compressedSizeBytes?: string;
  compressionRatio?: string;
  duration?: string;
}

/**
 * Duplicate file entry
 */
export interface DuplicateInfo {
  hash: string;
  originalPath: string;
  duplicatePath: string;
  scanRoot?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  duration?: string;
  // Metadata that may differ from original
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encodedBy?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
}

/**
 * Full recording details response from API
 */
export interface RecordingDetails {
  hash: string;
  entry: CatalogEntryResponse;
  sourceMetadata: SourceMetadataFields | null;
  sourceArchived: SourceArchivedFields | null;
  duplicates: DuplicateInfo[];
}

/**
 * Transform raw CSV metadata entry to frontend format
 */
export function transformMetadataEntry(
  raw: Record<string, string | undefined> | null
): SourceMetadataFields | null {
  if (!raw) return null;

  return {
    filename: raw["Filename"],
    sizeBytes: raw["Size (bytes)"],
    sizeHuman: raw["Size (human)"],
    fullPath: raw["Full Path"],
    scanRoot: raw["Scan Root"],
    status: raw["Status"],
    duration: raw["Duration"],
    album: raw["album"],
    artist: raw["artist"],
    comment: raw["comment"],
    date: raw["date"],
    encodedBy: raw["encoded_by"],
    encoder: raw["encoder"],
    genre: raw["genre"],
    title: raw["title"],
    track: raw["track"],
  };
}

/**
 * Transform raw CSV archived entry to frontend format
 */
export function transformArchivedEntry(
  raw: Record<string, string | undefined> | null
): SourceArchivedFields | null {
  if (!raw) return null;

  return {
    originalPath: raw["Original Path"],
    compressedPath: raw["Compressed Path"],
    format: raw["Format"],
    bitrateKbps: raw["Bitrate (kbps)"],
    originalSizeBytes: raw["Original Size (bytes)"],
    compressedSizeBytes: raw["Compressed Size (bytes)"],
    compressionRatio: raw["Compression Ratio"],
    duration: raw["Duration"],
  };
}

/**
 * Transform raw CSV duplicate entry to frontend format
 */
export function transformDuplicateEntry(
  raw: Record<string, string | undefined>
): DuplicateInfo {
  return {
    hash: raw["Hash"] || "",
    originalPath: raw["Original Path"] || "",
    duplicatePath: raw["Duplicate Path"] || "",
    scanRoot: raw["Scan Root"],
    sizeBytes: raw["Size (bytes)"],
    sizeHuman: raw["Size (human)"],
    duration: raw["Duration"],
    album: raw["album"],
    artist: raw["artist"],
    comment: raw["comment"],
    date: raw["date"],
    encodedBy: raw["encoded_by"],
    encoder: raw["encoder"],
    genre: raw["genre"],
    title: raw["title"],
    track: raw["track"],
  };
}
