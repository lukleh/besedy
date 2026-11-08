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

type LookupKind = keyof typeof LOOKUP_COLUMNS;
type LookupScope = { workflowGroupId: string };
type LookupRow = { id: number; name: string; createdAt: Date; updatedAt: Date };

/** Only the common operations used by the handlers, without model casts. */
interface LookupModel {
  findMany(args: {
    where: LookupScope; orderBy: { name: "asc" };
    select: { id: true; name: true; createdAt: true; updatedAt: true };
  }): Promise<LookupRow[]>;
  findFirst(args: {
    where: LookupScope & { id: number };
    select?: { id: true };
    include?: { _count: { select: { audioMetadata: true } } };
  }): Promise<{ id: number } | null>;
  create(args: { data: LookupScope & { name: string } }): Promise<LookupRow>;
  update(args: { where: { id: number }; data: { name: string } }): Promise<LookupRow>;
  delete(args: { where: { id: number } }): Promise<unknown>;
}

function createLookupHandlers(
  resource: LookupKind,
  hasReferences: (id: number) => Promise<boolean>,
  referenceDescription = "recordings",
) {
  const model = (): LookupModel => prisma[resource];
  const collection = {
    async GET(_request: NextRequest, { params }: CollectionRouteParams) {
      try {
        const userId = await requireAuth();
        const scope = await resolveCatalogScope(params, userId);
        if (scope.response) return scope.response;

        const items = await model().findMany({
          where: { workflowGroupId: scope.groupId },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        const countMap = await loadLookupCounts(scope.groupId, resource);

        // Merge counts into items
        const result = items.map((item) => ({
          ...item,
          _count: { audioMetadata: countMap.get(item.id) ?? 0 },
        }));

        return NextResponse.json(result);
      } catch (error) {
        return handlePrismaError(error, resource, "fetch");
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
        const item = await model().create({
          data: { name: trimmedName, workflowGroupId: scope.groupId },
        });
        return NextResponse.json(item, { status: 201 });
      } catch (error) {
        return handlePrismaError(error, resource, "create");
      }
    },
  };

  const item = {
    async GET(_request: NextRequest, { params }: ItemRouteParams) {
      try {
        const userId = await requireAuth();
        const scope = await resolveCatalogScope(params, userId);
        if (scope.response) return scope.response;
        const paramsResult = validateParams(await params, CatalogItemParamSchema);
        if (!paramsResult.success) return paramsResult.response;
        const { itemId: id } = paramsResult.data;
        const item = await model().findFirst({
          where: { id, workflowGroupId: scope.groupId },
          include: { _count: { select: { audioMetadata: true } } },
        });
        if (!item) return notFound(resource);
        return NextResponse.json(item);
      } catch (error) {
        return handlePrismaError(error, resource, "fetch");
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
        const existing = await model().findFirst({
          where: { id, workflowGroupId: scope.groupId },
          select: { id: true },
        });
        if (!existing) return notFound(resource);
        const item = await model().update({ where: { id }, data: { name: name.trim() } });
        return NextResponse.json(item);
      } catch (error) {
        return handlePrismaError(error, resource, "update");
      }
    },

    async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
      try {
        const scope = await resolveEditScope(params);
        if (scope.response) return scope.response;
        const paramsResult = validateParams(await params, CatalogItemParamSchema);
        if (!paramsResult.success) return paramsResult.response;
        const { itemId: id } = paramsResult.data;
        const existing = await model().findFirst({
          where: { id, workflowGroupId: scope.groupId },
          select: { id: true },
        });
        if (!existing) return notFound(resource);
        if (await hasReferences(id)) {
          return conflict(`Cannot delete ${resource}: it is referenced by existing ${referenceDescription}`);
        }
        await model().delete({ where: { id } });
        return NextResponse.json({ success: true });
      } catch (error) {
        return handlePrismaError(error, resource, "delete");
      }
    },
  };

  return { collection, item };
}

const recorder = createLookupHandlers("recorder", async (id) =>
  await prisma.audioMetadata.count({ where: { recorderId: id } }) > 0,
);
const location = createLookupHandlers("location", async (id) => {
  const [metadataCount, eventCount] = await Promise.all([
    prisma.audioMetadata.count({ where: { locationId: id } }),
    prisma.catalogEvent.count({ where: { locationId: id } }),
  ]);
  return metadataCount > 0 || eventCount > 0;
}, "recordings or events");
const album = createLookupHandlers("album", async (id) =>
  await prisma.audioMetadata.count({ where: { albumId: id } }) > 0,
);

export const recorderCollectionHandlers = recorder.collection;
export const recorderItemHandlers = recorder.item;
export const locationCollectionHandlers = location.collection;
export const locationItemHandlers = location.item;
export const albumCollectionHandlers = album.collection;
export const albumItemHandlers = album.item;
