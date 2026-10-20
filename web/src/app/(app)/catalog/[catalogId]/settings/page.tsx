import { redirect } from "next/navigation";
import CatalogSettingsContent from "./catalog-settings-content";
import type { CatalogSettingsCards } from "./catalog-settings-content-types";
import { getAdminCapability } from "@/lib/access/capabilities";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import { findActiveCatalog } from "@/lib/catalog/resolve-group";
import { getCatalogFeaturesForUser } from "@/lib/features/capabilities";

interface CatalogSettingsPageProps {
  params: Promise<{ catalogId: string }>;
}

export default async function CatalogSettingsPage({
  params,
}: CatalogSettingsPageProps) {
  const { catalogId } = await params;

  const { capability, userId } = await requireCatalogPageAccess(catalogId, {
    activeCatalogOnly: false,
  });

  const { data: features } = await getCatalogFeaturesForUser(catalogId, userId, {
    activeCatalogOnly: false,
  });

  // The page is a set of separately gated cards rather than one permission, so
  // what opens it is having any of them rather than a single settings right.
  const cards: CatalogSettingsCards = {
    transcriptExports: capability.canBulkExportTranscripts,
    correctionGuide: capability.canEditCorrectionGuide,
    configuration: capability.canManageCatalogConfiguration,
    eventHealth: features.features.events.canEdit,
    access: capability.canManageAccess,
    // The lookup routes serve active catalogs only.
    lookups: capability.canManageLookups && (await findActiveCatalog(catalogId)) !== null,
  };

  if (!Object.values(cards).some(Boolean)) {
    redirect(`/catalog/${catalogId}`);
  }

  // Catalog paths and the default and active flags stay with system admins
  // even when a catalog grant opens the configuration card (ADR 0005).
  const canEditPathsAndFlags =
    cards.configuration && (await getAdminCapability(userId)).canAccessAdmin;

  return (
    <CatalogSettingsContent
      catalogId={catalogId}
      cards={cards}
      canEditPathsAndFlags={canEditPathsAndFlags}
      skipCatalogValidation
    />
  );
}
