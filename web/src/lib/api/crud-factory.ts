import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  requireAuth,
  requireEditorOnAnyCatalog,
} from "@/lib/auth/permissions";
import { handlePrismaError, notFound, badRequest, forbidden, conflict } from "./errors";
import { validateRequestBody, validateParams, IntIdParamSchema } from "./validation";
import { CreateEnumSchema, UpdateEnumSchema } from "@/lib/validation/schemas";
import { loadCatalogHashes } from "@/lib/catalog";
import { resolveActiveGroupWithAccess } from "@/lib/catalog/resolve-group";

/**
 * Route params type for item routes.
 */
interface ItemRouteParams {
  params: Promise<{ id: string }>;
}

interface CatalogScopeResolution {
  catalogHashes: Set<string>;
  response?: NextResponse;
}

async function resolveCatalogScope(
  request: NextRequest,
  userId: string
): Promise<CatalogScopeResolution> {
  const { searchParams } = new URL(request.url);
  const groupOverride = searchParams.get("group");
  const { group, hasAccess } = await resolveActiveGroupWithAccess(groupOverride, userId);

  if (!group || !hasAccess) {
    return {
      catalogHashes: new Set<string>(),
      response: forbidden("Catalog access required"),
    };
  }

  return {
    catalogHashes: await loadCatalogHashes(group.id),
  };
}

// =============================================================================
// Recorder handlers
// =============================================================================

export const recorderCollectionHandlers = {
  async GET(request: NextRequest) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(request, userId);
      if (scope.response) return scope.response;

      // Get all recorders
      const items = await prisma.recorder.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Count metadata records filtered by catalog hashes
      const counts = await prisma.audioMetadata.groupBy({
        by: ["recorderId"],
        _count: { _all: true },
        where: { audioHash: { in: Array.from(scope.catalogHashes) } },
      });
      const countMap = new Map(counts.map((c) => [c.recorderId, c._count._all]));

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

  async POST(request: NextRequest) {
    try {
      await requireEditorOnAnyCatalog();
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.recorder.create({ data: { name: trimmedName } });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "recorder", "create");
    }
  },
};

export const recorderItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireAuth();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const item = await prisma.recorder.findUnique({
        where: { id },
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
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const item = await prisma.recorder.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "recorder", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
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
  async GET(request: NextRequest) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(request, userId);
      if (scope.response) return scope.response;

      // Get all locations
      const items = await prisma.location.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Count metadata records filtered by catalog hashes
      const counts = await prisma.audioMetadata.groupBy({
        by: ["locationId"],
        _count: { _all: true },
        where: { audioHash: { in: Array.from(scope.catalogHashes) } },
      });
      const countMap = new Map(counts.map((c) => [c.locationId, c._count._all]));

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

  async POST(request: NextRequest) {
    try {
      await requireEditorOnAnyCatalog();
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.location.create({ data: { name: trimmedName } });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "location", "create");
    }
  },
};

export const locationItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireAuth();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const item = await prisma.location.findUnique({
        where: { id },
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
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const item = await prisma.location.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "location", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
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
  async GET(request: NextRequest) {
    try {
      const userId = await requireAuth();
      const scope = await resolveCatalogScope(request, userId);
      if (scope.response) return scope.response;

      // Get all albums
      const items = await prisma.album.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Count metadata records filtered by catalog hashes
      const counts = await prisma.audioMetadata.groupBy({
        by: ["albumId"],
        _count: { _all: true },
        where: { audioHash: { in: Array.from(scope.catalogHashes) } },
      });
      const countMap = new Map(counts.map((c) => [c.albumId, c._count._all]));

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

  async POST(request: NextRequest) {
    try {
      await requireEditorOnAnyCatalog();
      const result = await validateRequestBody(request, CreateEnumSchema);
      if (!result.success) return result.response;
      const { name } = result.data;
      const trimmedName = name.trim();
      if (trimmedName.length === 0) return badRequest("Name is required");
      const item = await prisma.album.create({ data: { name: trimmedName } });
      return NextResponse.json(item, { status: 201 });
    } catch (error) {
      return handlePrismaError(error, "album", "create");
    }
  },
};

export const albumItemHandlers = {
  async GET(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireAuth();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const item = await prisma.album.findUnique({
        where: { id },
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
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
      const bodyResult = await validateRequestBody(request, UpdateEnumSchema);
      if (!bodyResult.success) return bodyResult.response;
      const { name } = bodyResult.data;
      if (!name || name.trim().length === 0) return badRequest("Name is required");
      const item = await prisma.album.update({ where: { id }, data: { name: name.trim() } });
      return NextResponse.json(item);
    } catch (error) {
      return handlePrismaError(error, "album", "update");
    }
  },

  async DELETE(_request: NextRequest, { params }: ItemRouteParams) {
    try {
      await requireEditorOnAnyCatalog();
      const paramsResult = validateParams(await params, IntIdParamSchema);
      if (!paramsResult.success) return paramsResult.response;
      const { id } = paramsResult.data;
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

// =============================================================================
// Distinct value handlers (read-only, from catalog CSVs)
// =============================================================================

export const artistsHandler = {
  async GET(request: NextRequest) {
    try {
      const userId = await requireAuth();
      const { searchParams } = new URL(request.url);
      const groupOverride = searchParams.get("group");

      // Import dynamically to avoid circular dependencies
      const { getDistinctArtists } = await import("@/lib/catalog");

      // Resolve the active group with access check
      const { group, hasAccess } = await resolveActiveGroupWithAccess(groupOverride, userId);
      if (!group) {
        return NextResponse.json([]);
      }

      if (!hasAccess) {
        return forbidden("Catalog access required");
      }

      // Get distinct artists from DB-backed catalog rows
      const artists = await getDistinctArtists(group.id);

      return NextResponse.json(artists);
    } catch (error) {
      return handlePrismaError(error, "artist", "fetch");
    }
  },
};

export const duplicateCountsHandler = {
  async GET(request: NextRequest) {
    try {
      const userId = await requireAuth();
      const { searchParams } = new URL(request.url);
      const groupOverride = searchParams.get("group");

      // Import dynamically to avoid circular dependencies
      const { getDistinctDuplicateCounts } = await import("@/lib/catalog");

      // Resolve the active group with access check
      const { group, hasAccess } = await resolveActiveGroupWithAccess(groupOverride, userId);
      if (!group) {
        return NextResponse.json([0]); // Fallback if no group
      }

      if (!hasAccess) {
        return forbidden("Catalog access required");
      }

      // Get real duplicate counts from DB-backed catalog rows
      const counts = await getDistinctDuplicateCounts(group.id);

      return NextResponse.json(counts);
    } catch (error) {
      return handlePrismaError(error, "duplicateCount", "fetch");
    }
  },
};
