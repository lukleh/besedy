import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import TranscriptOrderingContent from "./transcript-ordering-content";

/**
 * Admin page for managing transcript source ordering.
 * Requires: superadmin or admin role
 */
export default async function TranscriptsPage() {
  await requireAdminPageAccess();

  return <TranscriptOrderingContent />;
}
