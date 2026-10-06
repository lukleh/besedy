import { redirect } from "next/navigation";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import MetadataLayoutClient from "./metadata-layout-client";

interface MetadataLayoutProps {
  children: React.ReactNode;
  params: Promise<{ catalogId: string }>;
}

/**
 * The catalog's lookup lists (recorders, locations, albums). They open for the
 * same people the lookup routes let edit them: `manage_lookups` on this catalog
 * (ADR 0007). Everyone else goes back to the catalog. Like those routes, they
 * serve active catalogs only.
 */
export default async function MetadataLayout({ children, params }: MetadataLayoutProps) {
  const { catalogId } = await params;
  const { capability } = await requireCatalogPageAccess(catalogId);
  if (!capability.canManageLookups) {
    redirect(`/catalog/${catalogId}`);
  }

  return <MetadataLayoutClient catalogId={catalogId}>{children}</MetadataLayoutClient>;
}
