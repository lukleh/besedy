import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireCatalogManagementAccess } from "@/lib/access/catalog-management-route-access";
import { requireCatalogEventsAccess } from "@/lib/catalog-events/access";
import { IntIdSchema, validateParams } from "@/lib/api/validation";
import { validatePath } from "@/lib/security/path-validation";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import {
  readEventSources,
  resolveEventSourcesDir,
  writeEventSources,
} from "@/lib/event-sources";
import type {
  RecordingSource,
  RecordingSourceFile,
  RecordingSourceUrl,
} from "@/types/recording-sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 100 * 1000 * 1000; // 100 MB

const SourceTypeSchema = z.enum(["url", "file"]);
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
  params: Promise<{ id: string; eventId: string }>;
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

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value
  );
}

function getSafeExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return "";
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) return "";
  return ext;
}

async function requireEvent(catalogId: string, eventId: number): Promise<boolean> {
  const event = await prisma.catalogEvent.findFirst({
    where: { id: eventId, workflowGroupId: catalogId },
    select: { id: true },
  });
  return !!event;
}

/**
 * GET /api/catalogs/:id/events/:eventId/sources - List available sources
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const paramsResult = validateParams(await params, CatalogEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

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
    return NextResponse.json({ eventId, sources });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching event sources:", error);
    return NextResponse.json(
      { error: "Failed to fetch event sources" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/catalogs/:id/events/:eventId/sources - Add a source
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: "Upload too large" },
        { status: 413 }
      );
    }

    const paramsResult = validateParams(await params, CatalogEventParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { id: catalogId, eventId } = paramsResult.data;

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

    const formData = await request.formData();
    const typeResult = SourceTypeSchema.safeParse(formData.get("type"));
    if (!typeResult.success) {
      return NextResponse.json({ error: "Invalid source type" }, { status: 400 });
    }

    const dir = resolveEventSourcesDir(catalogId, eventId);
    // Use mode 0o777 to allow both dev (root) and prod (non-root) to write.
    await fs.mkdir(dir, { recursive: true, mode: 0o777 });
    const dirValidation = validatePath(dir);
    if (!dirValidation.valid) {
      return NextResponse.json({ error: "Invalid sources directory" }, { status: 403 });
    }

    const sources = await readEventSources(catalogId, eventId);
    const sourceId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    let newSource: RecordingSource;

    if (typeResult.data === "url") {
      const titleValue = formData.get("title");
      const urlValue = formData.get("url");
      const parsed = UrlPayloadSchema.safeParse({
        title: typeof titleValue === "string" ? titleValue : undefined,
        url: typeof urlValue === "string" ? urlValue : "",
      });
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues[0]?.message ?? "Invalid URL source" },
          { status: 400 }
        );
      }

      const normalizedUrl = new URL(parsed.data.url).toString();
      newSource = {
        id: sourceId,
        type: "url",
        title: parsed.data.title,
        url: normalizedUrl,
        createdAt,
      } satisfies RecordingSourceUrl;
    } else {
      const fileValue = formData.get("file");
      if (!isFile(fileValue)) {
        return NextResponse.json({ error: "File is required" }, { status: 400 });
      }
      if (fileValue.size === 0) {
        return NextResponse.json({ error: "File cannot be empty" }, { status: 400 });
      }
      if (fileValue.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: "Upload too large" },
          { status: 413 }
        );
      }

      const ext = getSafeExtension(fileValue.name);
      const storedName = `source_${sourceId}${ext}`;
      const filePath = path.join(dirValidation.resolvedPath, storedName);
      const buffer = Buffer.from(await fileValue.arrayBuffer());
      await fs.writeFile(filePath, buffer);

      newSource = {
        id: sourceId,
        type: "file",
        storedName,
        originalName: fileValue.name,
        size: fileValue.size,
        mimeType: fileValue.type || null,
        createdAt,
      } satisfies RecordingSourceFile;
    }

    sources.push(newSource);
    await writeEventSources(dirValidation.resolvedPath, sources);

    return NextResponse.json({ source: newSource });
  } catch (error) {
    if (isAuthError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error adding event source:", error);
    return NextResponse.json(
      { error: "Failed to add source" },
      { status: 500 }
    );
  }
}
