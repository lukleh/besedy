import type { Prisma } from '@/generated/prisma/client';

/** Refresh CSV-owned fields without replacing publication state or row identity. */
export async function syncCatalogEntries(
  tx: Prisma.TransactionClient,
  groupId: string,
  entries: Prisma.CatalogEntryCreateManyInput[],
  syncedAt: Date,
): Promise<void> {
  await tx.catalogEntry.deleteMany({
    where: {
      workflowGroupId: groupId,
      audioHash: { notIn: entries.map((entry) => entry.audioHash) },
    },
  });
  if (entries.length === 0) return;

  // One bulk update keeps the existing rows locked through commit. A concurrent
  // publisher can run before or after it; this statement never writes their flag.
  await tx.$executeRaw`
    UPDATE catalog_entry AS entry SET
      compressed_path = source."compressedPath",
      compressed_aac_path = source."compressedAacPath",
      original_path = source."originalPath",
      filename = source.filename,
      scan_root = source."scanRoot",
      duration_hms = source."durationHms",
      source_title = source."sourceTitle",
      source_artist = source."sourceArtist",
      source_album = source."sourceAlbum",
      source_date = source."sourceDate",
      source_metadata_payload = source."sourceMetadataPayload",
      source_archived_payload = source."sourceArchivedPayload",
      details_payload_version = source."detailsPayloadVersion",
      has_archived = source."hasArchived",
      has_metadata = source."hasMetadata",
      is_actionable = source."isActionable",
      duplicate_count = source."duplicateCount",
      updated_at = ${syncedAt}
    FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS source(
      "audioHash" text,
      "compressedPath" text,
      "compressedAacPath" text,
      "originalPath" text,
      filename text,
      "scanRoot" text,
      "durationHms" text,
      "sourceTitle" text,
      "sourceArtist" text,
      "sourceAlbum" text,
      "sourceDate" text,
      "sourceMetadataPayload" jsonb,
      "sourceArchivedPayload" jsonb,
      "detailsPayloadVersion" integer,
      "hasArchived" boolean,
      "hasMetadata" boolean,
      "isActionable" boolean,
      "duplicateCount" integer
    )
    WHERE entry.workflow_group_id = ${groupId}
      AND entry.audio_hash = source."audioHash"
  `;

  // Publication defaults to false only for genuinely new recordings. Existing
  // rows are left intact, including changes made by publishers during sync.
  await tx.catalogEntry.createMany({ data: entries, skipDuplicates: true });
}
