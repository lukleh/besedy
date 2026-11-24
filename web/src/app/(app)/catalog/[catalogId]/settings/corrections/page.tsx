import { notFound } from "next/navigation";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";
import { CorrectionAdminOverviewPage } from "@/components/correction/correction-admin-overview";

interface CorrectionAdminOverviewRouteProps {
  params: Promise<{ catalogId: string }>;
}

export default async function CorrectionAdminOverviewRoute({
  params,
}: CorrectionAdminOverviewRouteProps) {
  const { catalogId } = await params;
  const { capability } = await requireCatalogPageAccess(catalogId);

  // The page names people and what each has done, so it is for whoever
  // administers correction; correctors have their own overview.
  if (!capability.canAdministerCorrection) {
    notFound();
  }

  return <CorrectionAdminOverviewPage catalogId={catalogId} />;
}
