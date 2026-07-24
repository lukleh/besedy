import { notFound, redirect } from "next/navigation";
import {
  getCatalogCapability,
  type CatalogCapability,
} from "@/lib/access/capabilities";
import { getSession } from "@/lib/auth/session";

interface RequireCatalogPageAccessOptions {
  activeCatalogOnly?: boolean;
  unauthenticatedRedirect?: string;
  unauthorizedRedirect?: string | null;
}

export interface CatalogPageAccessResult {
  userId: string;
  capability: CatalogCapability;
}

/**
 * Resolve catalog access for server page entry points.
 *
 * Server pages should make a single authoritative decision here before
 * rendering a client shell or loading feature-specific data.
 */
export async function requireCatalogPageAccess(
  catalogId: string,
  options: RequireCatalogPageAccessOptions = {}
): Promise<CatalogPageAccessResult> {
  const resolved = {
    unauthenticatedRedirect: "/auth/signin",
    unauthorizedRedirect: null,
    ...options,
  };

  const session = await getSession();
  if (!session?.user?.id) {
    redirect(resolved.unauthenticatedRedirect);
  }

  const capability = await getCatalogCapability(catalogId, session.user.id, {
    activeCatalogOnly: resolved.activeCatalogOnly,
  });

  if (!capability.catalogExists) {
    notFound();
  }

  if (!capability.hasAccess) {
    if (resolved.unauthorizedRedirect) {
      redirect(resolved.unauthorizedRedirect);
    }
    notFound();
  }

  return {
    userId: session.user.id,
    capability,
  };
}
