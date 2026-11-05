import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireAuth } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { handlePrismaError, notFound, badRequest, forbidden, conflict } from "./errors";
import { z } from "zod";
import { validateRequestBody, validateParams, IntIdSchema } from "./validation";
import {
  CreateEnumSchema,
  TimestampIdParamSchema,
  TimestampIdSchema,
  UpdateEnumSchema,
} from "@/lib/validation/schemas";
import { resolveCatalogWithAccess } from "@/lib/catalog/resolve-group";

/** Params of `/api/catalogs/:id/metadata/<resource>`. */
interface CollectionRouteParams {
  params: Promise<{ id: string }>;
}

/** Params of `/api/catalogs/:id/metadata/<resource>/:itemId`. */
interface ItemRouteParams {
  params: Promise<{ id: string; itemId: string }>;
}

const CatalogItemParamSchema = z.object({ id: TimestampIdSchema, itemId: IntIdSchema });

const EMPTY_SCOPE = { groupId: "", canEdit: false };

interface CatalogScopeResolution {
  groupId: string;
  canEdit: boolean;
  response?: NextResponse;
}

/**
 * Resolve the catalog these lookups belong to.
 *
 * Lookups are per catalog, so every read is filtered by the resolved catalog and
 * every write both requires `manage_lookups` on it and files the row under it.
 * That is the permission ADR 0007 names for these rows; it is not
 * `edit_metadata`, which is the curated metadata of one recording.
 */
async function resolveCatalogScope(
  params: Promise<{ id: string }>,
  userId: string
): Promise<CatalogScopeResolution> {
  const paramsResult = validateParams(await params, TimestampIdParamSchema);
  if (!paramsResult.success) return { ...EMPTY_SCOPE, response: paramsResult.response };
  const { group, hasAccess } = await resolveCatalogWithAccess(paramsResult.data.id, userId);

  if (!group) return { ...EMPTY_SCOPE, response: notFound("catalog") };
  if (!hasAccess) return { ...EMPTY_SCOPE, response: forbidden("Catalog access required") };

  const capability = await getCatalogCapability(group.id, userId);

  return {
    groupId: group.id,
    canEdit: capability.canManageLookups,
  };
}

/** Resolve the scope for a write, refusing when the actor may not manage lookups here. */
async function resolveEditScope(
  params: Promise<{ id: string }>
): Promise<CatalogScopeResolution> {
  const userId = await requireAuth();
  const scope = await resolveCatalogScope(params, userId);
  if (scope.response) return scope;
  if (!scope.canEdit) {
    return {
      ...scope,
      response: forbidden("Lookup-management permission required to edit catalog lookups"),
    };
  }
  return scope;
}

const LOOKUP_COLUMNS = {
  recorder: Prisma.sql`m.recorder_id`,
  location: Prisma.sql`m.location_id`,
  album: Prisma.sql`m.album_id`,
};

/** Count only metadata whose recording is present in this catalog. */
async function loadLookupCounts(
  groupId: string,
  lookup: keyof typeof LOOKUP_COLUMNS,
): Promise<Map<number, number>> {
  const column = LOOKUP_COLUMNS[lookup];
  const counts = await prisma.$queryRaw<Array<{ id: number; count: number }>>(Prisma.sql`
    SELECT ${column} AS id, COUNT(*)::int AS count
    FROM audio_metadata m
    JOIN catalog_entry e
      ON e.workflow_group_id = m.workflow_group_id AND e.audio_hash = m.audio_hash
    WHERE m.workflow_group_id = ${groupId} AND ${column} IS NOT NULL
    GROUP BY ${column}
  `);
  return new Map(counts.map((row) => [row.id, row.count]));
}

// =============================================================================
// Recorder handlers
// =============================================================================

export const recorderCollectionHandlers = {
  async GET(_request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;

      const items = await prisma.recorder.findMany({
        where: { workflowGroupId: scope.groupId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const countMap = await loadLookupCounts(scope.groupId, "recorder");

      // Merge counts into items
      const result = items.map((item) => ({
        ...item,
        _count: { audioMetadata: countMap.get(item.id) ?? 0 },
      }));

      return NextResponse.json(result);
    } catch (error) {
      return handlePrismaError(error, "recorder", "fetch");
    }
  },

  async POST(request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.recorder.create({
        data: { name: trimmedName, workflowGroupId: scope.groupId },
      });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "recorder", "create");
    }
  },
};

export const recorderItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const item = await prisma.recorder.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        include: { _count: { select: { audioMetadata: true } } },
      });
      if (!item) return notFound("recorder");
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "recorder", "fetch");
    }
  },

  async PUT(request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const existing = await prisma.recorder.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("recorder");
      const item = await prisma.recorder.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "recorder", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const existing = await prisma.recorder.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("recorder");
      const referenceCount = await prisma.audioMetadata.count({ where: { recorderId: id } });
      if (referenceCount > 0) {
        return conflict("Cannot delete recorder: it is referenced by existing recordings");
      }
      await prisma.recorder.delete({ where: { id } });
      return NextResponse.json({ success: true });
    } catch (error) {
      return handlePrismaError(error, "recorder", "delete");
    }
  },
};

// =============================================================================
// Location handlers
// =============================================================================

export const locationCollectionHandlers = {
  async GET(_request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;

      const items = await prisma.location.findMany({
        where: { workflowGroupId: scope.groupId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const countMap = await loadLookupCounts(scope.groupId, "location");

      // Merge counts into items
      const result = items.map((item) => ({
        ...item,
        _count: { audioMetadata: countMap.get(item.id) ?? 0 },
      }));

      return NextResponse.json(result);
    } catch (error) {
      return handlePrismaError(error, "location", "fetch");
    }
  },

  async POST(request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.location.create({
        data: { name: trimmedName, workflowGroupId: scope.groupId },
      });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "location", "create");
    }
  },
};

export const locationItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const item = await prisma.location.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        include: { _count: { select: { audioMetadata: true } } },
      });
      if (!item) return notFound("location");
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "location", "fetch");
    }
  },

  async PUT(request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const existing = await prisma.location.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("location");
      const item = await prisma.location.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "location", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const existing = await prisma.location.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("location");
      const [metadataCount, eventCount] = await Promise.all([
        prisma.audioMetadata.count({ where: { locationId: id } }),
        prisma.catalogEvent.count({ where: { locationId: id } }),
      ]);
      if (metadataCount > 0 || eventCount > 0) {
        return conflict("Cannot delete location: it is referenced by existing recordings or events");
      }
      await prisma.location.delete({ where: { id } });
      return NextResponse.json({ success: true });
    } catch (error) {
      return handlePrismaError(error, "location", "delete");
    }
  },
};

// =============================================================================
// Album handlers
// =============================================================================

export const albumCollectionHandlers = {
  async GET(_request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;

      const items = await prisma.album.findMany({
        where: { workflowGroupId: scope.groupId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const countMap = await loadLookupCounts(scope.groupId, "album");

      // Merge counts into items
      const result = items.map((item) => ({
        ...item,
        _count: { audioMetadata: countMap.get(item.id) ?? 0 },
      }));

      return NextResponse.json(result);
    } catch (error) {
      return handlePrismaError(error, "album", "fetch");
    }
  },

  async POST(request: NextRequest, { params }: CollectionRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.album.create({
        data: { name: trimmedName, workflowGroupId: scope.groupId },
      });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "album", "create");
    }
  },
};

export const albumItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(params, userId);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const item = await prisma.album.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        include: { _count: { select: { audioMetadata: true } } },
      });
      if (!item) return notFound("album");
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "album", "fetch");
    }
  },

  async PUT(request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const existing = await prisma.album.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("album");
      const item = await prisma.album.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "album", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      const scope = await resolveEditScope(params);
      if (scope.response) return scope.response;
      const paramsResult = validateParams(await params, CatalogItemParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { itemId: id } = paramsResult.data;
      const existing = await prisma.album.findFirst({
        where: { id, workflowGroupId: scope.groupId },
        select: { id: true },
      });
      if (!existing) return notFound("album");
      const referenceCount = await prisma.audioMetadata.count({ where: { albumId: id } });
      if (referenceCount > 0) {
        return conflict("Cannot delete album: it is referenced by existing recordings");
      }
      await prisma.album.delete({ where: { id } });
      return NextResponse.json({ success: true });
    } catch (error) {
      return handlePrismaError(error, "album", "delete");
    }
  },
};
