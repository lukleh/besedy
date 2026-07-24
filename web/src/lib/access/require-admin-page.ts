import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getAdminCapability } from "@/lib/access/capabilities";
import { ADMIN_PAGE_REDIRECTS } from "@/lib/access/admin-page-access";

interface RequireAdminPageAccessOptions {
  unauthenticatedRedirect?: string;
  unauthorizedRedirect?: string;
}

export async function requireAdminPageAccess(
  options?: RequireAdminPageAccessOptions
) {
  const redirects = {
    ...ADMIN_PAGE_REDIRECTS,
    ...options,
  };

  const session = await getSession();
  if (!session?.user?.id) {
    redirect(redirects.unauthenticatedRedirect);
  }

  const capability = await getAdminCapability(session.user.id);
  if (!capability.canAccessAdmin) {
    redirect(redirects.unauthorizedRedirect);
  }

  return { userId: session.user.id, capability };
}
