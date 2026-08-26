import { NextResponse } from "next/server";
import { logAccessDenied } from "@/lib/audit/logger";
import { requireAuth } from "@/lib/auth/permissions";
import { forbidden, notFound } from "@/lib/api";
import {
  hasSystemCatalogAuthority,
  resolveCatalogActorContext,
  type CatalogActorContext,
} from "@/lib/policy/actor";
import {
  hasCatalogManagementAuthority,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";

export interface CatalogManagementRouteAccessContext {
  ok: true;
  userId: string;
  catalogId: string;
  actor: CatalogActorContext;
  policyContext: CatalogPolicyContext;
}

export interface CatalogManagementRouteAccessFailure {
  ok: false;
  response: NextResponse;
}

interface CatalogManagementResolveOptions {
  userId?: string;
  activeCatalogOnly?: boolean;
}

interface CatalogManagementAccessOptions {
  userId?: string;
  activeCatalogOnly?: boolean;
  auditResource: string;
  auditResourceId: string;
  deniedMessage: string;
  deniedReason: string;
  auditMetadata?: Record<string, unknown>;
  authorize?: (context: CatalogPolicyContext) => boolean;
}

function createCatalogPolicyContext(actor: CatalogActorContext): CatalogPolicyContext {
  return {
    catalogExists: actor.catalogExists,
    canEnterPortal: actor.canEnterPortal,
    catalogGrant: actor.catalogGrant,
    isCatalogAdmin: actor.isCatalogAdmin,
  };
}

function normalizeManagementActor(
  actor: CatalogActorContext,
  options: CatalogManagementResolveOptions
): CatalogActorContext {
  if (options.activeCatalogOnly !== false || actor.catalogExists || !actor.canEnterPortal) {
    return actor;
  }

  const isElevatedAdmin = hasSystemCatalogAuthority(actor);

  if (!isElevatedAdmin) {
    return actor;
  }

  return {
    ...actor,
    catalogGrant: null,
    hasCatalogAccess: false,
    isCatalogOwner: false,
    isCatalogAdmin: true,
  };
}

export async function resolveCatalogManagementActor(
  catalogId: string,
  options: CatalogManagementResolveOptions = {}
): Promise<
  CatalogManagementRouteAccessContext | CatalogManagementRouteAccessFailure
> {
  const userId = options.userId ?? (await requireAuth());
  const actor = normalizeManagementActor(await resolveCatalogActorContext(catalogId, userId, {
    activeCatalogOnly: options.activeCatalogOnly,
  }), options);
  const policyContext = createCatalogPolicyContext(actor);

  return {
    ok: true,
    userId,
    catalogId,
    actor,
    policyContext,
  };
}

export async function requireCatalogManagementAccess(
  catalogId: string,
  options: CatalogManagementAccessOptions
): Promise<
  CatalogManagementRouteAccessContext | CatalogManagementRouteAccessFailure
> {
  const resolved = await resolveCatalogManagementActor(catalogId, {
    userId: options.userId,
    activeCatalogOnly: options.activeCatalogOnly,
  });
  if (!resolved.ok) {
    return resolved;
  }
  const { userId, actor, policyContext } = resolved;

  if (!actor.catalogExists) {
    return {
      ok: false,
      response: notFound("catalog"),
    };
  }

  const authorize =
    options.authorize ?? hasCatalogManagementAuthority;

  if (!authorize(policyContext)) {
    await logAccessDenied(userId, options.auditResource, options.auditResourceId, {
      catalogId,
      reason: options.deniedReason,
      ...options.auditMetadata,
    });

    return {
      ok: false,
      response: forbidden(options.deniedMessage),
    };
  }

  return {
    ...resolved,
  };
}
