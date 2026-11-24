import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import { requireArchive } from "@/lib/archive";
import { CorrectionAdminOverviewPage } from "@/components/correction/correction-admin-overview";

/**
 * Admin page showing who is correcting what across the catalog.
 * Requires: superadmin or admin role
 */
export default async function AdminCorrectionsPage() {
  await requireAdminPageAccess();
  const archive = await requireArchive();

  return <CorrectionAdminOverviewPage catalogId={archive.id} />;
}
