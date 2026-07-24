import type {
  ArchivedPayload,
  CatalogEntry,
  DuplicateEntry,
  DuplicatePayload,
  FullArchivedEntry,
  FullMetadataEntry,
  MetadataPayload,
} from "./catalog-types";

interface JsonObject {
  [key: string]: unknown;
}

export interface CatalogEntryRow {
  audioHash: string;
  compressedPath: string | null;
  filename: string | null;
  originalPath: string | null;
  scanRoot: string | null;
  durationHms: string | null;
  sourceTitle: string | null;
  sourceArtist: string | null;
  sourceAlbum: string | null;
  sourceDate: string | null;
  hasArchived: boolean;
  hasMetadata: boolean;
  isActionable: boolean;
  isPublished: boolean;
}

function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function mapCatalogEntryRowToCatalogEntry(row: CatalogEntryRow): CatalogEntry {
  return {
    hash: row.audioHash,
    compressedPath: row.compressedPath ?? undefined,
    filename: row.filename ?? undefined,
    originalPath: row.originalPath ?? undefined,
    scanRoot: row.scanRoot ?? undefined,
    duration: row.durationHms ?? undefined,
    title: row.sourceTitle ?? undefined,
    artist: row.sourceArtist ?? undefined,
    sourceAlbum: row.sourceAlbum ?? undefined,
    date: row.sourceDate ?? undefined,
    hasArchived: row.hasArchived,
    hasMetadata: row.hasMetadata,
    isActionable: row.isActionable,
    isPublished: row.isPublished,
  };
}

export function mapMetadataPayloadToFullMetadata(
  hash: string,
  payload: unknown,
): FullMetadataEntry | null {
  const p = asJsonObject(payload);
  if (Object.keys(p).length === 0) return null;

  return {
    Hash: hash,
    Filename: getOptionalString(p.filename),
    "Size (bytes)": getOptionalString(p.sizeBytes),
    "Size (human)": getOptionalString(p.sizeHuman),
    "Full Path": getOptionalString(p.fullPath),
    "Scan Root": getOptionalString(p.scanRoot),
    Status: getOptionalString(p.status),
    Duration: getOptionalString(p.duration),
    album: getOptionalString(p.album),
    artist: getOptionalString(p.artist),
    comment: getOptionalString(p.comment),
    date: getOptionalString(p.date),
    encoded_by: getOptionalString(p.encodedBy),
    encoder: getOptionalString(p.encoder),
    genre: getOptionalString(p.genre),
    title: getOptionalString(p.title),
    track: getOptionalString(p.track),
  };
}

export function mapArchivedPayloadToFullArchived(
  hash: string,
  payload: unknown,
): FullArchivedEntry | null {
  const p = asJsonObject(payload);
  if (Object.keys(p).length === 0) return null;

  return {
    Hash: hash,
    "Original Path": getOptionalString(p.originalPath) ?? "",
    "Compressed Path": getOptionalString(p.compressedPath) ?? "",
    Format: getOptionalString(p.format),
    "Bitrate (kbps)": getOptionalString(p.bitrateKbps),
    "Original Size (bytes)": getOptionalString(p.originalSizeBytes),
    "Compressed Size (bytes)": getOptionalString(p.compressedSizeBytes),
    "Compression Ratio": getOptionalString(p.compressionRatio),
    Duration: getOptionalString(p.duration),
  };
}

export function mapDuplicatePayloadToDuplicateEntry(
  hash: string,
  originalPath: string,
  duplicatePath: string,
  payload: unknown,
): DuplicateEntry {
  const p = asJsonObject(payload);
  return {
    Hash: getOptionalString(p.hash) ?? hash,
    "Original Path": getOptionalString(p.originalPath) ?? originalPath,
    "Duplicate Path": getOptionalString(p.duplicatePath) ?? duplicatePath,
    "Scan Root": getOptionalString(p.scanRoot),
    "Size (bytes)": getOptionalString(p.sizeBytes),
    "Size (human)": getOptionalString(p.sizeHuman),
    Duration: getOptionalString(p.duration),
    album: getOptionalString(p.album),
    artist: getOptionalString(p.artist),
    comment: getOptionalString(p.comment),
    date: getOptionalString(p.date),
    encoded_by: getOptionalString(p.encodedBy),
    encoder: getOptionalString(p.encoder),
    genre: getOptionalString(p.genre),
    title: getOptionalString(p.title),
    track: getOptionalString(p.track),
  };
}

export function buildMetadataPayloadFromRaw(
  raw: Record<string, string | undefined>,
): MetadataPayload {
  return {
    filename: raw["Filename"],
    sizeBytes: raw["Size (bytes)"],
    sizeHuman: raw["Size (human)"],
    fullPath: raw["Full Path"],
    scanRoot: raw["Scan Root"],
    status: raw["Status"],
    duration: raw["Duration"],
    album: raw.album,
    artist: raw.artist,
    comment: raw.comment,
    date: raw.date,
    encodedBy: raw.encoded_by,
    encoder: raw.encoder,
    genre: raw.genre,
    title: raw.title,
    track: raw.track,
  };
}

export function buildArchivedPayloadFromRaw(
  raw: Record<string, string | undefined>,
): ArchivedPayload {
  return {
    originalPath: raw["Original Path"],
    compressedPath: raw["Compressed Path"],
    format: raw.Format,
    bitrateKbps: raw["Bitrate (kbps)"],
    originalSizeBytes: raw["Original Size (bytes)"],
    compressedSizeBytes: raw["Compressed Size (bytes)"],
    compressionRatio: raw["Compression Ratio"],
    duration: raw.Duration,
  };
}

export function buildDuplicatePayloadFromRaw(
  raw: Record<string, string | undefined>,
): DuplicatePayload {
  return {
    hash: raw.Hash,
    originalPath: raw["Original Path"],
    duplicatePath: raw["Duplicate Path"],
    scanRoot: raw["Scan Root"],
    sizeBytes: raw["Size (bytes)"],
    sizeHuman: raw["Size (human)"],
    duration: raw.Duration,
    album: raw.album,
    artist: raw.artist,
    comment: raw.comment,
    date: raw.date,
    encodedBy: raw.encoded_by,
    encoder: raw.encoder,
    genre: raw.genre,
    title: raw.title,
    track: raw.track,
  };
}
