import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DELETE as deleteMetadata,
  GET as getMetadata,
  PUT as putMetadata,
} from "@/app/api/catalogs/[id]/recordings/[hash]/metadata/route";

const CATALOG_ID = "20251225_120000";
const HASH = "a".repeat(64);

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/access/capabilities", () => ({
  getRecordingCapability: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
  logContentEvent: vi.fn(),
  logMetadataUpdated: vi.fn(),
  logMetadataVerified: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    catalogEntry: {
      findUnique: vi.fn(),
    },
    audioMetadata: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
    },
    workflowGroup: {
      update: vi.fn(),
    },
  },
}));

describe("recording metadata route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getRecordingCapability: ReturnType<typeof vi.fn>;
  let prisma: {
    catalogEntry: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    audioMetadata: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    workflowGroup: {
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const permissionsModule = await import("@/lib/auth/permissions");
    requireAuth = permissionsModule.requireAuth as ReturnType<typeof vi.fn>;
    const accessModule = await import("@/lib/access/capabilities");
    getRecordingCapability =
      accessModule.getRecordingCapability as ReturnType<typeof vi.fn>;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  it("returns 404 when the catalog capability says the catalog does not exist", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`
    );
    const response = await getMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    expect(prisma.audioMetadata.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 on GET when a listener cannot access the recording itself", async () => {
    requireAuth.mockResolvedValue("listener-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: false,
    });
    prisma.catalogEntry.findUnique.mockResolvedValue({ audioHash: HASH });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`
    );
    const response = await getMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    expect(prisma.audioMetadata.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 on GET when the recording is missing from the catalog", async () => {
    requireAuth.mockResolvedValue("viewer-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessRecording: true,
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`
    );
    const response = await getMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    expect(prisma.audioMetadata.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 on PUT when the user cannot edit metadata", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditMetadata: false,
      canEditRecording: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`,
      {
        method: "PUT",
        body: JSON.stringify({ title: "Updated title" }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const response = await putMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    expect(prisma.audioMetadata.upsert).not.toHaveBeenCalled();
  });

  it("returns 404 on PUT when the recording is missing from the catalog", async () => {
    requireAuth.mockResolvedValue("editor-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditRecording: true,
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`,
      {
        method: "PUT",
        body: JSON.stringify({ title: "Updated title" }),
        headers: { "Content-Type": "application/json" },
      }
    );
    const response = await putMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    expect(prisma.audioMetadata.upsert).not.toHaveBeenCalled();
  });

  it("returns 403 on DELETE when the user cannot edit metadata", async () => {
    requireAuth.mockResolvedValue("user-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditMetadata: false,
      canEditRecording: false,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`,
      { method: "DELETE" }
    );
    const response = await deleteMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    expect(prisma.audioMetadata.delete).not.toHaveBeenCalled();
  });

  it("returns 404 on DELETE when the recording is missing from the catalog", async () => {
    requireAuth.mockResolvedValue("editor-1");
    getRecordingCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canEditRecording: true,
    });
    prisma.catalogEntry.findUnique.mockResolvedValue(null);

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/metadata`,
      { method: "DELETE" }
    );
    const response = await deleteMetadata(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(404);
    expect(prisma.audioMetadata.delete).not.toHaveBeenCalled();
  });
});
