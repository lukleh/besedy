import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ZipFile } from "yazl";
import prisma from "@/lib/db";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { logAccessDenied, logDataAccessEvent } from "@/lib/audit/logger";
import { loadCatalogHashes } from "@/lib/catalog";
import { resolveTranscriptsPath } from "@/lib/paths";
import { getRagBackendKey } from "@/lib/runtime-config";
import { readTranscriptFile } from "@/lib/transcript";
import { parseDateFromString } from "@/lib/date-utils";
import { validateParams, notFound } from "@/lib/api";
import {
  TimestampIdParamSchema,
  TranscriptBackendSchema,
} from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ExportModeSchema = z.enum(["zip", "txt"]);

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface TranscriptEntry {
  hash: string;
  content: string;
}

interface TranscriptHeaderContext {
  dateLabel: string;
  locationLabel: string;
}

function getContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}

function normalizeTextContent(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function buildMergedContent(
  details: {
    catalogId: string;
    backend: string;
    headerContextByHash: Map<string, TranscriptHeaderContext>;
  },
  entries: TranscriptEntry[],
  skipped: number
): string {
  const exportedAt = new Date().toISOString();
  const headerLines = [
    `# Catalog: ${details.catalogId}`,
    `# Backend: ${details.backend}`,
    `# Exported at: ${exportedAt}`,
    `# Included transcripts: ${entries.length}`,
    `# Missing skipped: ${skipped}`,
    "",
  ];

  const blocks = entries.map((entry) => {
    const text = normalizeTextContent(entry.content);
    const context = details.headerContextByHash.get(entry.hash);
    const dateLabel = context?.dateLabel ?? "Unknown date";
    const locationLabel = context?.locationLabel ?? "Unknown location";
    return `===== ${dateLabel} | ${locationLabel} | ${entry.hash} =====\n${text}`;
  });

  return `${headerLines.join("\n")}${blocks.join("\n")}`;
}

function formatDateLabel(parts: {
  year?: number;
  month?: number;
  day?: number;
} | null): string {
  if (!parts?.year) return "Unknown date";
  const year = String(parts.year);
  if (!parts.month) return year;
  const month = String(parts.month).padStart(2, "0");
  if (!parts.day) return `${year}-${month}`;
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function buildTranscriptHeaderContext(
  catalogId: string,
  hashes: string[]
): Promise<Map<string, TranscriptHeaderContext>> {
  if (hashes.length === 0) {
    return new Map();
  }

  const [metadataRows, catalogRows] = await Promise.all([
    prisma.audioMetadata.findMany({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: hashes },
      },
      select: {
        audioHash: true,
        dateYear: true,
        dateMonth: true,
        dateDay: true,
        location: {
          select: { name: true },
        },
      },
    }),
    prisma.catalogEntry.findMany({
      where: {
        workflowGroupId: catalogId,
        audioHash: { in: hashes },
      },
      select: {
        audioHash: true,
        sourceDate: true,
      },
    }),
  ]);

  const metadataByHash = new Map(metadataRows.map((row) => [row.audioHash, row]));
  const sourceDateByHash = new Map(catalogRows.map((row) => [row.audioHash, row.sourceDate]));
  const contextByHash = new Map<string, TranscriptHeaderContext>();

  for (const hash of hashes) {
    const metadata = metadataByHash.get(hash);
    const locationLabel = metadata?.location?.name?.trim() || "Unknown location";

    const curatedDateParts =
      metadata && (metadata.dateYear || metadata.dateMonth || metadata.dateDay)
        ? {
            year: metadata.dateYear ?? undefined,
            month: metadata.dateMonth ?? undefined,
            day: metadata.dateDay ?? undefined,
          }
        : null;
    const fallbackDateParts = parseDateFromString(sourceDateByHash.get(hash) ?? null);
    const dateLabel = formatDateLabel(curatedDateParts ?? fallbackDateParts);

    contextByHash.set(hash, { dateLabel, locationLabel });
  }

  return contextByHash;
}

async function collectTxtTranscripts(
  transcriptsPath: string,
  backend: string,
  hashes: string[]
): Promise<{ entries: TranscriptEntry[]; skipped: number }> {
  const entries: TranscriptEntry[] = [];
  let skipped = 0;

  for (const hash of hashes) {
    const transcript = await readTranscriptFile(transcriptsPath, hash, backend, "txt");
    if (!transcript) {
      skipped += 1;
      continue;
    }
    entries.push({ hash, content: transcript.content });
  }

  return { entries, skipped };
}

function buildZipFilename(catalogId: string, backend: string): string {
  const safeBackend = backend.replace(/[^\w.-]+/g, "_");
  return `transcripts_${catalogId}_${safeBackend}.zip`;
}

function buildMergedFilename(catalogId: string, backend: string): string {
  const safeBackend = backend.replace(/[^\w.-]+/g, "_");
  return `transcripts_${catalogId}_${safeBackend}.txt`;
}

/**
 * GET /api/catalogs/:id/transcript-export
 *
 * Query params:
 * - mode: zip | txt (default: zip)
 *
 * Uses the same transcript backend as RAG search (RAG_BACKEND_KEY).
 * Missing transcript.txt files are skipped.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, TimestampIdParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const catalogId = paramsResult.data.id;

    const { searchParams } = new URL(request.url);
    const includeInactive = searchParams.get("includeInactive") === "true";
    const modeResult = ExportModeSchema.safeParse(searchParams.get("mode") ?? "zip");
    if (!modeResult.success) {
      return NextResponse.json(
        { error: "Invalid mode, expected 'zip' or 'txt'" },
        { status: 400 }
      );
    }
    const mode = modeResult.data;

    const userId = await requireAuth();
    const capability = await getCatalogCapability(catalogId, userId, {
      activeCatalogOnly: includeInactive ? false : undefined,
    });
    if (!capability.catalogExists) {
      return notFound("catalog");
    }

    if (
      !capability.hasAccess ||
      !capability.canDownload ||
      !capability.canViewTranscripts
    ) {
      await logAccessDenied(userId, "transcript", catalogId, {
        groupId: catalogId,
        reason: "Bulk transcript download requires MEMBER role or higher",
      });
      return NextResponse.json(
        { error: "Download not permitted for this catalog" },
        { status: 403 }
      );
    }

    const rawBackend = getRagBackendKey();
    const backendResult = TranscriptBackendSchema.safeParse(rawBackend);
    if (!backendResult.success) {
      return NextResponse.json(
        { error: `Invalid RAG backend key configuration: ${rawBackend}` },
        { status: 500 }
      );
    }
    const backend = backendResult.data;

    const hashes = Array.from(await loadCatalogHashes(catalogId)).sort();
    if (hashes.length === 0) {
      return NextResponse.json(
        { error: "Catalog has no recordings to export" },
        { status: 404 }
      );
    }

    const transcriptsPath = resolveTranscriptsPath(catalogId);
    const { entries, skipped } = await collectTxtTranscripts(
      transcriptsPath,
      backend,
      hashes
    );

    if (entries.length === 0) {
      return NextResponse.json(
        { error: `No transcript.txt files found for backend '${backend}'` },
        { status: 404 }
      );
    }

    await logDataAccessEvent({
      userId,
      action: "TRANSCRIPT_DOWNLOADED",
      resource: "transcript",
      resourceId: catalogId,
      groupId: catalogId,
      subjectType: "catalog",
      subjectSnapshot: {
        type: "catalog",
        id: catalogId,
        label: catalogId,
        catalogId,
      },
      details: {
        backend,
        mode,
        format: mode === "zip" ? "zip" : "txt",
        totalHashes: hashes.length,
        exportedTranscripts: entries.length,
        skippedMissing: skipped,
      },
    });

    if (mode === "txt") {
      const headerContextByHash = await buildTranscriptHeaderContext(catalogId, hashes);
      const mergedContent = buildMergedContent(
        { catalogId, backend, headerContextByHash },
        entries,
        skipped
      );
      const filename = buildMergedFilename(catalogId, backend);

      return new NextResponse(mergedContent, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": getContentDisposition(filename),
        },
      });
    }

    const zip = new ZipFile();
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.content, "utf-8"), `${entry.hash}.txt`);
    }

    const manifest = {
      catalogId,
      backend,
      exportedAt: new Date().toISOString(),
      totalHashes: hashes.length,
      exportedTranscripts: entries.length,
      skippedMissing: skipped,
    };
    zip.addBuffer(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"), "manifest.json");
    zip.end();

    const filename = buildZipFilename(catalogId, backend);
    return new NextResponse(zip.outputStream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": getContentDisposition(filename),
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error exporting transcripts:", error);
    return NextResponse.json(
      { error: "Failed to export transcripts" },
      { status: 500 }
    );
  }
}
