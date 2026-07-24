export interface ArchivedEntry {
  Hash: string;
  "Original Path": string;
  "Compressed Path": string;
  Duration?: string;
  "File Size"?: string;
}

export interface FullArchivedEntry {
  Hash: string;
  "Original Path": string;
  "Compressed Path": string;
  Format?: string;
  "Bitrate (kbps)"?: string;
  "Original Size (bytes)"?: string;
  "Compressed Size (bytes)"?: string;
  "Compression Ratio"?: string;
  Duration?: string;
  [key: string]: string | undefined;
}

export interface MetadataEntry {
  Hash: string;
  Filename?: string;
  "Original Path"?: string;
  Duration?: string;
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  [key: string]: string | undefined;
}

export interface FullMetadataEntry {
  Hash: string;
  Filename?: string;
  "Size (bytes)"?: string;
  "Size (human)"?: string;
  "Full Path"?: string;
  Status?: string;
  Duration?: string;
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encoded_by?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
  sample_rate?: string;
  bit_depth?: string;
  channels?: string;
  bitrate_kbps?: string;
  codec_profile?: string;
  integrated_loudness_lufs?: string;
  true_peak_db?: string;
  loudness_range_lu?: string;
  input_thresh?: string;
  target_offset?: string;
  needs_normalization?: string;
  [key: string]: string | undefined;
}

export interface DuplicateEntry {
  Hash: string;
  "Original Path": string;
  "Duplicate Path": string;
  "Size (bytes)"?: string;
  "Size (human)"?: string;
  Duration?: string;
  album?: string;
  artist?: string;
  comment?: string;
  date?: string;
  encoded_by?: string;
  encoder?: string;
  genre?: string;
  title?: string;
  track?: string;
  [key: string]: string | undefined;
}

export interface CatalogEntry {
  hash: string;
  compressedPath?: string;
  filename?: string;
  originalPath?: string;
  scanRoot?: string;
  duration?: string;
  title?: string;
  artist?: string;
  sourceAlbum?: string;
  date?: string;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
}

export interface MetadataPayload {
  [key: string]: string | undefined;
  filename?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  fullPath?: string;
  scanRoot?: string;
  status?: string;
  duration?: string;
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

export interface ArchivedPayload {
  [key: string]: string | undefined;
  originalPath?: string;
  compressedPath?: string;
  format?: string;
  bitrateKbps?: string;
  originalSizeBytes?: string;
  compressedSizeBytes?: string;
  compressionRatio?: string;
  duration?: string;
}

export interface DuplicatePayload {
  [key: string]: string | undefined;
  hash?: string;
  originalPath?: string;
  duplicatePath?: string;
  scanRoot?: string;
  sizeBytes?: string;
  sizeHuman?: string;
  duration?: string;
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

export interface FullRecordingDetails {
  entry: CatalogEntry;
  fullMetadata: FullMetadataEntry | null;
  fullArchived: FullArchivedEntry | null;
  duplicates: DuplicateEntry[];
}

export interface EnrichedCatalogEntry extends CatalogEntry {
  curated: boolean;
  curatedTitle?: string | null;
  curatedArtist?: string | null;
  curatedDate?: string | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  verified: boolean;
  verifiedAt: string | null;
  tags: string[];
  notes: string | null;
  recorderId: number | null;
  recorder: { id: number; name: string } | null;
  locationId: number | null;
  location: { id: number; name: string } | null;
  albumId: number | null;
  album: { id: number; name: string } | null;
  part: number | null;
  duplicateCount: number;
}

export const EMPTY_FILTER = -1;
export const EMPTY_STRING_FILTER = "__empty__";

export interface CatalogFilters {
  status?: "ready" | "incomplete" | null;
  duration?: "short" | "medium" | "long" | null;
  verified?: boolean | null;
  recorder?: number | null;
  location?: number | null;
  album?: number | null;
  part?: number | null;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  artist?: string | null;
  duplicates?: number | null;
  actionableOnly?: boolean;
}
