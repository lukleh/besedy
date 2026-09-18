import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import { SettingsContent } from "@/components/settings/settings-content";

/**
 * Admin page for managing workflow groups (catalogs)
 * Requires: superadmin or admin role
 */
export default async function CatalogsPage() {
  await requireAdminPageAccess();

  return <SettingsContent />;
}
