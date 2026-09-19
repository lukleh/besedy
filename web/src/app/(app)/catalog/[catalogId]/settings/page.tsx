import { redirect } from "next/navigation";
import CatalogSettingsContent from "./catalog-settings-content";
import type { CatalogSettingsCards } from "./catalog-settings-content-types";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
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
    transcriptExports: capability.canDownload && capability.canViewTranscripts,
    configuration: capability.canManageCatalogConfiguration,
    eventHealth: features.features.events.canEdit,
    access: capability.canManageAccess,
  };

  if (!Object.values(cards).some(Boolean)) {
    redirect(`/catalog/${catalogId}`);
  }

  return (
    <CatalogSettingsContent
      catalogId={catalogId}
      cards={cards}
      skipCatalogValidation
    />
  );
}
