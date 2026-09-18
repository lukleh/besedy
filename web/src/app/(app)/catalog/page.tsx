import { redirect } from "next/navigation";
import prisma from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  getAdminCapability,
  getCatalogDiscoveryCapability,
} from "@/lib/access/capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

function buildQuerySuffix(searchParams?: SearchParams): string {
  if (!searchParams) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (typeof item === "string" && item.length > 0) {
          params.append(key, item);
        }
      });
    } else if (typeof value === "string" && value.length > 0) {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export default async function CatalogIndexPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const querySuffix = buildQuerySuffix(resolvedSearchParams);
  const session = await getSession();

  if (!session?.user) {
    redirect("/auth/signin");
  }

  const userId = session.user.id ?? "local";
  const [discovery, adminCapability] = await Promise.all([
    getCatalogDiscoveryCapability(userId),
    getAdminCapability(userId),
  ]);
  const accessibleIds = discovery.accessibleCatalogIds;

  // No catalog access - redirect to no-access page
  // (admins/superadmins always have access via getAccessibleWorkflowGroups)
  if (accessibleIds.length === 0) {
    if (adminCapability.canAccessAdmin) {
      // Admins without explicit access can still manage catalogs
      redirect("/admin/catalogs");
    }
    redirect("/auth/no-access");
  }

  // Check user's active group preference
  const prefs = await prisma.userPreferences.findUnique({
    where: { userId },
    include: { activeGroup: true },
  });

  // If user has an active preference and it's accessible, use it
  if (prefs?.activeGroup?.isActive && accessibleIds.includes(prefs.activeGroup.id)) {
    redirect(`/catalog/${prefs.activeGroup.id}${querySuffix}`);
  }

  // Find first accessible catalog (prefer default, then latest)
  const accessibleCatalog = await prisma.workflowGroup.findFirst({
    where: {
      id: { in: accessibleIds },
      isActive: true,
    },
    orderBy: [{ isDefault: "desc" }, { id: "desc" }],
  });

  if (accessibleCatalog) {
    redirect(`/catalog/${accessibleCatalog.id}${querySuffix}`);
  }

  // Fallback: no accessible active catalogs
  redirect("/auth/no-access");
}
