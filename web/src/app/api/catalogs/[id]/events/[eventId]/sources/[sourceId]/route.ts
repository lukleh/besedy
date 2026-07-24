import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { validatePathAsync } from "@/lib/security/path-validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import {
  readEventSources,
  resolveEventSourcesDir,
  writeEventSources,
} from "@/lib/event-sources";
import type { RecordingSourceFile } from "@/types/recording-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SourceIdSchema = z.string().min(1).max(200);
const UrlPayloadSchema = z.object({
  title: z.string().trim().max(200).optional().default(""),
  url: z
    .string()
    .trim()
    .url()
    .max(2000)
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "URL must start with http:// or https://",
    }),
});

interface RouteParams {
  params: Promise<{ id: string; eventId: string; sourceId: string }>;
}

const CatalogEventParamSchema = z.object({
  id: TimestampIdSchema,
  eventId: IntIdSchema,
});

function isAuthError(error: unknown): error is { message: string; statusCode: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    "message" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number" &&
    typeof (error as { message: unknown }).message === "string"
  );
}

function getContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`;
}

async function requireEvent(catalogId: string, eventId: number): Promise<boolean> {
  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    select: { id: true },
  });
  return !!event;
}

/**
 * GET /api/catalogs/:id/events/:eventId/sources/:sourceId - Open URL/file
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const rawParams = await params;
    const paramsResult = validateParams(
      { id: rawParams.id, eventId: rawParams.eventId },
      CatalogEventParamSchema
    );
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const rawSourceId = rawParams.sourceId;

    const sourceIdResult = SourceIdSchema.safeParse(rawSourceId);
    if (!sourceIdResult.success) {
      return NextResponse.json({ error: "Invalid source id" }, { status: 400 });
    }
    const sourceId = sourceIdResult.data;

    const { userId } = await requireCatalogEventsAccess(catalogId, "view");
    const access = await requireCatalogManagementAccess(catalogId, {
      userId,
      auditResource: "event_sources",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to sources",
      deniedReason: "Not owner/admin",
    });
    if (!access.ok) {
      return access.response;
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const sources = await readEventSources(catalogId, eventId);
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    if (source.type === "url") return NextResponse.redirect(source.url, 302);

    const fileSource = source as RecordingSourceFile;
    const dir = resolveEventSourcesDir(catalogId, eventId);
    const filePath = path.join(dir, fileSource.storedName);

    const pathValidation = await validatePathAsync(filePath);
    if (!pathValidation.valid) {
      if (pathValidation.reason === "Path does not exist or is not accessible") {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
      return NextResponse.json({ error: "Invalid file path" }, { status: 403 });
    }

    const stat = await fs.promises.stat(pathValidation.resolvedPath);
    const contentType = fileSource.mimeType || "application/octet-stream";
    const stream = fs.createReadStream(pathValidation.resolvedPath);
    const downloadName = fileSource.originalName || fileSource.storedName;

    return new NextResponse(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
        "Content-Disposition": getContentDisposition(downloadName),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching event source:", error);
    return NextResponse.json(
      { error: "Failed to fetch event source" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/catalogs/:id/events/:eventId/sources/:sourceId - Update URL source
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const rawParams = await params;
    const paramsResult = validateParams(
      { id: rawParams.id, eventId: rawParams.eventId },
      CatalogEventParamSchema
    );
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const rawSourceId = rawParams.sourceId;

    const sourceIdResult = SourceIdSchema.safeParse(rawSourceId);
    if (!sourceIdResult.success) {
      return NextResponse.json({ error: "Invalid source id" }, { status: 400 });
    }
    const sourceId = sourceIdResult.data;

    const { userId } = await requireCatalogEventsAccess(catalogId, "view");
    const access = await requireCatalogManagementAccess(catalogId, {
      userId,
      auditResource: "event_sources",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to sources",
      deniedReason: "Not owner/admin",
    });
    if (!access.ok) {
      return access.response;
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const parsed = UrlPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
        { status: 400 }
      );
    }

    const sources = await readEventSources(catalogId, eventId);
    const index = sources.findIndex((item) => item.id === sourceId);
    if (index === -1) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }
    const source = sources[index];
    if (source.type !== "url") {
      return NextResponse.json(
        { error: "Only URL sources can be edited" },
        { status: 400 }
      );
    }

    const dir = resolveEventSourcesDir(catalogId, eventId);
    await fs.promises.mkdir(dir, { recursive: true });
    const dirValidation = await validatePathAsync(dir);
    if (!dirValidation.valid) {
      return NextResponse.json({ error: "Invalid sources directory" }, { status: 403 });
    }

    const normalizedUrl = new URL(parsed.data.url).toString();
    const updated = {
      ...source,
      title: parsed.data.title,
      url: normalizedUrl,
      updatedAt: new Date().toISOString(),
    };

    sources[index] = updated;
    await writeEventSources(dirValidation.resolvedPath, sources);

    return NextResponse.json({ source: updated });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error updating event source:", error);
    return NextResponse.json(
      { error: "Failed to update event source" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/catalogs/:id/events/:eventId/sources/:sourceId - Delete source
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const rawParams = await params;
    const paramsResult = validateParams(
      { id: rawParams.id, eventId: rawParams.eventId },
      CatalogEventParamSchema
    );
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;
    const rawSourceId = rawParams.sourceId;

    const sourceIdResult = SourceIdSchema.safeParse(rawSourceId);
    if (!sourceIdResult.success) {
      return NextResponse.json({ error: "Invalid source id" }, { status: 400 });
    }
    const sourceId = sourceIdResult.data;

    const { userId } = await requireCatalogEventsAccess(catalogId, "view");
    const access = await requireCatalogManagementAccess(catalogId, {
      userId,
      auditResource: "event_sources",
      auditResourceId: String(eventId),
      deniedMessage: "Access denied to sources",
      deniedReason: "Not owner/admin",
    });
    if (!access.ok) {
      return access.response;
    }

    const eventExists = await requireEvent(catalogId, eventId);
    if (!eventExists) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const sources = await readEventSources(catalogId, eventId);
    const index = sources.findIndex((item) => item.id === sourceId);
    if (index === -1) {
      return NextResponse.json({ error: "Source not found" }, { status: 404 });
    }

    const [removed] = sources.splice(index, 1);

    const dir = resolveEventSourcesDir(catalogId, eventId);
    await fs.promises.mkdir(dir, { recursive: true });
    const dirValidation = await validatePathAsync(dir);
    if (!dirValidation.valid) {
      return NextResponse.json({ error: "Invalid sources directory" }, { status: 403 });
    }

    if (removed.type === "file") {
      const filePath = path.join(dirValidation.resolvedPath, removed.storedName);
      const fileValidation = await validatePathAsync(filePath);
      if (!fileValidation.valid) {
        if (fileValidation.reason !== "Path does not exist or is not accessible") {
          return NextResponse.json({ error: "Invalid file path" }, { status: 403 });
        }
      } else {
        try {
          await fs.promises.unlink(fileValidation.resolvedPath);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") {
            throw err;
          }
        }
      }
    }

    await writeEventSources(dirValidation.resolvedPath, sources);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error deleting event source:", error);
    return NextResponse.json(
      { error: "Failed to delete event source" },
      { status: 500 }
    );
  }
}
