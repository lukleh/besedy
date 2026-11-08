import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/lib/db";
import { registerArchiveSource } from "@/lib/archive-registration";

vi.mock("@/lib/db", () => ({ default: { workflowGroup: { create: vi.fn() } } }));

const ID = "20251225_120000";
const paths = { archivedCatalogPath: "/data/archive.csv", metadataCatalogPath: "/data/metadata.csv" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BESEDY_ARCHIVE_ID", ID);
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit source bootstrap", () => {
  it("creates only the configured source with the operator's paths", async () => {
    vi.mocked(prisma.workflowGroup.create).mockResolvedValue({ id: ID } as never);
    await registerArchiveSource({ ...paths, label: "Archive", duplicatesCatalogPath: null });
    expect(prisma.workflowGroup.create).toHaveBeenCalledWith({
      data: { id: ID, ...paths, label: "Archive", duplicatesCatalogPath: null },
    });
  });

  it.each(["", "latest", "../20251225_120000"])("refuses missing or invalid configuration %j before writing", async (id) => {
    vi.stubEnv("BESEDY_ARCHIVE_ID", id);
    await expect(registerArchiveSource(paths)).rejects.toThrow("BESEDY_ARCHIVE_ID");
    expect(prisma.workflowGroup.create).not.toHaveBeenCalled();
  });

  it.each([
    { metadataCatalogPath: paths.metadataCatalogPath },
    { ...paths, archivedCatalogPath: "" },
    { ...paths, metadataCatalogPath: "x".repeat(501) },
    { ...paths, label: "x".repeat(101) },
    { ...paths, id: "20260101_120000" },
    { ...paths, isDefault: true },
    { ...paths, isActive: false },
  ])("rejects incomplete or retired setup fields before writing: %j", async (input) => {
    await expect(registerArchiveSource(input)).rejects.toThrow();
    expect(prisma.workflowGroup.create).not.toHaveBeenCalled();
  });

  it("propagates an existing-ID failure instead of updating the source", async () => {
    const duplicate = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    vi.mocked(prisma.workflowGroup.create).mockRejectedValue(duplicate);
    await expect(registerArchiveSource(paths)).rejects.toBe(duplicate);
    expect(prisma.workflowGroup.create).toHaveBeenCalledTimes(1);
  });
});
