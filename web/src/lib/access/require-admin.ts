import { getAdminCapability } from "@/lib/access/capabilities";
import { AuthError, requireAuth } from "@/lib/auth/permissions";

interface RequireAdminCapabilityOptions {
  message?: string;
}

export async function requireAdminCapability(
  options?: RequireAdminCapabilityOptions
) {
  const userId = await requireAuth();
  const capability = await getAdminCapability(userId);

  if (!capability.canAccessAdmin) {
    throw new AuthError(options?.message ?? "Admin access required", 403);
  }

  return { userId, capability };
}
