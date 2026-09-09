import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import IngestContent from "./ingest-content";

/**
 * Admin page for uploading recordings and following their ingest jobs.
 * Requires: superadmin or admin role
 */
export default async function IngestPage() {
  await requireAdminPageAccess();

  return <IngestContent />;
}
