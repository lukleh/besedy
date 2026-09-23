import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/catalogs/route";
import { syncCatalogGroup } from "@/lib/catalog-sync";
import prisma from "@/lib/db";

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  getCurrentUserId: vi.fn(async () => "admin-1"),
  AuthError: class AuthError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 403) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogDiscoveryCapability: vi.fn(),
}));

vi.mock("@/lib/access/require-admin", () => ({
  requireAdminCapability: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit/logger", () => ({
  logCatalogLifecycleEvent: vi.fn(),
}));

vi.mock("@/lib/catalog-sync", () => ({
  syncCatalogGroup: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const GROUP_ID = "20260923_061236";
const group = {
  id: GROUP_ID,
  label: "New catalog",
  archivedCatalogPath: "/data/text/catalogs/audio_catalog_20260923_061236_loudness_archived.csv",
  metadataCatalogPath: "/data/text/catalogs/audio_catalog_20260923_061236.csv",
  transcriptsPath: null,
  isDefault: false,
};

function createRequest() {
  return new NextRequest("http://localhost/api/catalogs", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      id: group.id,
      label: group.label,
      archivedCatalogPath: group.archivedCatalogPath,
      metadataCatalogPath: group.metadataCatalogPath,
    }),
  });
}

describe("POST /api/catalogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.workflowGroup.create).mockResolvedValue(group as never);
  });

  it("syncs the new catalog so its recordings appear immediately", async () => {
    vi.mocked(syncCatalogGroup).mockResolvedValue({
      groupId: GROUP_ID,
      status: "success",
      changedSources: ["metadata", "archived"],
      rowCounts: { metadata: 2, archived: 2 },
    });

    const response = await POST(createRequest());

    expect(response.status).toBe(201);
    expect(syncCatalogGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(vi.mocked(syncCatalogGroup).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(prisma.workflowGroup.create).mock.invocationCallOrder[0],
    );
    const body = await response.json();
    expect(body.id).toBe(GROUP_ID);
    expect(body.catalogSync).toMatchObject({ status: "success", rowCounts: { metadata: 2 } });
  });

  it("keeps the created catalog when the initial sync reports an error", async () => {
    vi.mocked(syncCatalogGroup).mockResolvedValue({
      groupId: GROUP_ID,
      status: "error",
      changedSources: [],
      rowCounts: {},
      error: "ENOENT: metadata CSV not found",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(createRequest());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBe(GROUP_ID);
    expect(body.catalogSync).toMatchObject({
      status: "error",
      error: "ENOENT: metadata CSV not found",
    });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps the created catalog when the initial sync throws", async () => {
    vi.mocked(syncCatalogGroup).mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(createRequest());

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.catalogSync).toMatchObject({
      groupId: GROUP_ID,
      status: "error",
      error: "database unavailable",
    });
    consoleError.mockRestore();
  });

  it("does not sync when the catalog could not be created", async () => {
    vi.mocked(prisma.workflowGroup.create).mockRejectedValue(new Error("unique constraint"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(createRequest());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(syncCatalogGroup).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
