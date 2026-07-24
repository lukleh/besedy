"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useSession } from "@/contexts/session-context";
import { fetchJson } from "@/lib/api/fetch-json";
import { ADMIN_STATUS_QUERY_PROFILE } from "@/lib/query/profiles";

interface AdminPermissions {
  isSuperadmin: boolean;
  isAdmin: boolean;
  canAccessAdmin: boolean;
  hasEditorOnAnyCatalog: boolean;
}

interface AdminStatus extends AdminPermissions {
  isLoading: boolean;
  isError: boolean;
}

const adminPermissionsSchema = z.object({
  isSuperadmin: z.boolean(),
  isAdmin: z.boolean(),
  canAccessAdmin: z.boolean(),
  hasEditorOnAnyCatalog: z.boolean(),
});

const defaultPermissions: AdminPermissions = {
  isSuperadmin: false,
  isAdmin: false,
  canAccessAdmin: false,
  hasEditorOnAnyCatalog: false,
};

/**
 * Hook to check current user's admin permissions
 * Uses React Query with caching (5 min stale time)
 */
export function useAdminStatus(): AdminStatus {
  const { session, isPending } = useSession();
  const isAuthenticated = !!session?.user;

  const { data, isLoading, isError } = useQuery<AdminPermissions>({
    queryKey: ["me", "permissions"],
    queryFn: () =>
      fetchJson<AdminPermissions>("/api/me/permissions", {
        schema: adminPermissionsSchema,
      }),
    enabled: isAuthenticated,
    ...ADMIN_STATUS_QUERY_PROFILE,
  });

  return {
    ...(data ?? defaultPermissions),
    isLoading: isLoading || isPending,
    isError,
  };
}
