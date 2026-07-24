import { redirect } from "next/navigation";
import CatalogSettingsContent from "./catalog-settings-content";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";

interface CatalogSettingsPageProps {
  params: Promise<{ catalogId: string }>;
}

export default async function CatalogSettingsPage({
  params,
}: CatalogSettingsPageProps) {
  const { catalogId } = await params;

  const { capability } = await requireCatalogPageAccess(catalogId, {
    activeCatalogOnly: false,
  });
  if (!capability.canAccessSettings) {
    redirect(`/catalog/${catalogId}`);
  }

  return (
    <CatalogSettingsContent
      catalogId={catalogId}
      skipCatalogValidation
    />
  );
}
