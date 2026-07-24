import { NextResponse } from "next/server";
import {
  getRecordingCapability,
  type RecordingCapability,
} from "@/lib/access/capabilities";
import { logAccessDenied } from "@/lib/audit/logger";
import { requireAuth } from "@/lib/auth/permissions";

export interface CatalogRecordingRouteAccessContext {
  ok: true;
  userId: string;
  catalogId: string;
  hash: string;
  capability: RecordingCapability;
}

export interface CatalogRecordingRouteAccessFailure {
  ok: false;
  response: NextResponse;
}

export async function resolveCatalogRecordingRouteAccess(
  catalogId: string,
  hash: string
): Promise<
  CatalogRecordingRouteAccessContext | CatalogRecordingRouteAccessFailure
> {
  const userId = await requireAuth();
  const capability = await getRecordingCapability(catalogId, hash, userId);

  if (!capability.catalogExists) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Catalog not found" },
        { status: 404 }
      ),
    };
  }

  return {
    ok: true,
    userId,
    catalogId,
    hash,
    capability,
  };
}

interface AccessDeniedOptions {
  auditResource: string;
  deniedMessage: string;
  auditResourceId?: string;
  reason?: string;
  status?: number;
}

export async function requireCatalogAccess(
  context: CatalogRecordingRouteAccessContext,
  options: AccessDeniedOptions
): Promise<NextResponse | null> {
  if (context.capability.hasAccess) {
    return null;
  }

  await logAccessDenied(
    context.userId,
    options.auditResource,
    options.auditResourceId ?? context.hash,
    {
      groupId: context.catalogId,
      reason: options.reason ?? "No access grant",
    }
  );

  return NextResponse.json(
    { error: options.deniedMessage },
    { status: options.status ?? 403 }
  );
}

export async function requireCatalogRecordingAccess(
  context: CatalogRecordingRouteAccessContext,
  options: AccessDeniedOptions
): Promise<NextResponse | null> {
  if (context.capability.canAccessRecording) {
    return null;
  }

  await logAccessDenied(context.userId, options.auditResource, context.hash, {
    groupId: context.catalogId,
    reason: options.reason,
  });

  return NextResponse.json(
    { error: options.deniedMessage },
    { status: options.status ?? 403 }
  );
}

export async function requireCatalogRecordingDownload(
  context: CatalogRecordingRouteAccessContext,
  options: AccessDeniedOptions
): Promise<NextResponse | null> {
  if (context.capability.canDownloadRecording) {
    return null;
  }

  await logAccessDenied(context.userId, options.auditResource, context.hash, {
    groupId: context.catalogId,
    reason: options.reason ?? "Download not permitted",
  });

  return NextResponse.json(
    { error: options.deniedMessage },
    { status: options.status ?? 403 }
  );
}

export async function requireCatalogRecordingEditAccess(
  context: CatalogRecordingRouteAccessContext,
  options: AccessDeniedOptions
): Promise<NextResponse | null> {
  if (context.capability.hasAccess && context.capability.canEditRecording) {
    return null;
  }

  await logAccessDenied(context.userId, options.auditResource, context.hash, {
    groupId: context.catalogId,
    reason:
      options.reason ??
      (context.capability.hasAccess
        ? "Edit permission required"
        : "No access grant"),
  });

  return NextResponse.json(
    { error: options.deniedMessage },
    { status: options.status ?? 403 }
  );
}
