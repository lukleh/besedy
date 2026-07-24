import { describe, expect, it } from "vitest";
import { isAdminPagePath } from "@/lib/access/admin-page-access";

describe("admin page access helpers", () => {
  it("matches the admin root and nested admin pages", () => {
    expect(isAdminPagePath("/admin")).toBe(true);
    expect(isAdminPagePath("/admin/users")).toBe(true);
    expect(isAdminPagePath("/admin/catalogs")).toBe(true);
  });

  it("does not match non-admin paths with similar prefixes", () => {
    expect(isAdminPagePath("/administrator")).toBe(false);
    expect(isAdminPagePath("/catalog/admin")).toBe(false);
    expect(isAdminPagePath("/auth/signin")).toBe(false);
  });
});
