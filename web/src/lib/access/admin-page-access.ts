export const ADMIN_PAGE_REDIRECTS = {
  unauthenticatedRedirect: "/",
  unauthorizedRedirect: "/",
} as const;

export function isAdminPagePath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}
