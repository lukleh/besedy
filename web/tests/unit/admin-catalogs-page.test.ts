import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogsPage from "@/app/(app)/admin/catalogs/page";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), archive: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); } }));
vi.mock("@/lib/access/require-admin-page", () => ({ requireAdminPageAccess: mocks.admin }));
vi.mock("@/lib/archive", () => ({ requireArchive: mocks.archive }));
describe("archive settings entry", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.admin.mockResolvedValue({}); mocks.archive.mockResolvedValue({ id: "bound" }); });
  it("opens the one archive settings page without a catalog-management screen", async () => {
    await expect(CatalogsPage()).rejects.toThrow("NEXT_REDIRECT:/catalog/bound/settings");
  });
  it("checks administrator access before resolving the archive", async () => {
    mocks.admin.mockRejectedValue(new Error("Denied"));
    await expect(CatalogsPage()).rejects.toThrow("Denied");
    expect(mocks.archive).not.toHaveBeenCalled();
  });
});
