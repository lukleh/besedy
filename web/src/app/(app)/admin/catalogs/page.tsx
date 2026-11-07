import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import { redirect } from "next/navigation";
import { requireArchive } from "@/lib/archive";

/**
 * The retained admin entry point opens the configured archive's settings.
 * Requires: superadmin or admin role
 */
export default async function CatalogsPage() {
  await requireAdminPageAccess();

  const archive = await requireArchive();
  redirect(`/catalog/${archive.id}/settings`);
}
