import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import AdminLayoutClient from "./admin-layout-client";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPageAccess();

  return <AdminLayoutClient>{children}</AdminLayoutClient>;
}
