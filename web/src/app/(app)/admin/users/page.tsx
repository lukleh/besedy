import UsersPageContent from "./users-content";
import { requireAdminPageAccess } from "@/lib/access/require-admin-page";

export default async function UsersPage() {
  await requireAdminPageAccess();

  return <UsersPageContent />;
}
