import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as exportCatalogTranscripts } from "@/app/api/catalogs/[id]/transcript-export/route";

vi.mock("@/lib/auth/permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/permissions")>(
    "@/lib/auth/permissions"
  );
  return {
    ...actual,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: vi.fn(),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAccessDenied: vi.fn(),
  logAudit: vi.fn(),
  logDataAccessEvent: vi.fn(),
  AuditAction: {
    TRANSCRIPT_DOWNLOADED: "TRANSCRIPT_DOWNLOADED",
  },
}));

vi.mock("@/lib/catalog", () => ({
  loadCatalogHashes: vi.fn(),
}));

vi.mock("@/lib/paths", () => ({
  resolveTranscriptsPath: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRagBackendKey: vi.fn(),
}));

vi.mock("@/lib/transcript", () => ({
  readTranscriptFile: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: {
      findFirst: vi.fn(),
    },
    audioMetadata: {
      findMany: vi.fn(),
    },
    catalogEntry: {
      findMany: vi.fn(),
    },
  },
}));

const CATALOG_ID = "20251225_120000";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("catalog transcript export route", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getCatalogCapability: ReturnType<typeof vi.fn>;
  let loadCatalogHashes: ReturnType<typeof vi.fn>;
  let resolveTranscriptsPath: ReturnType<typeof vi.fn>;
  let getRagBackendKey: ReturnType<typeof vi.fn>;
  let readTranscriptFile: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    audioMetadata: { findMany: ReturnType<typeof vi.fn> };
    catalogEntry: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<
      typeof vi.fn
    >;
    getCatalogCapability = (
      await import("@/lib/access/capabilities")
    ).getCatalogCapability as ReturnType<typeof vi.fn>;
    loadCatalogHashes = (await import("@/lib/catalog")).loadCatalogHashes as ReturnType<
      typeof vi.fn
    >;
    resolveTranscriptsPath = (
      await import("@/lib/paths")
    ).resolveTranscriptsPath as ReturnType<typeof vi.fn>;
    getRagBackendKey = (
      await import("@/lib/runtime-config")
    ).getRagBackendKey as ReturnType<typeof vi.fn>;
    readTranscriptFile = (
      await import("@/lib/transcript")
    ).readTranscriptFile as ReturnType<typeof vi.fn>;

    prisma = (await import("@/lib/db")).default as unknown as {
      workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
      audioMetadata: { findMany: ReturnType<typeof vi.fn> };
      catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    };
  });

  it("returns 403 when user cannot download", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canDownload: false,
      canViewTranscripts: true,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/transcript-export?mode=txt`
    );
    const response = await exportCatalogTranscripts(request, {
      params: Promise.resolve({ id: CATALOG_ID }),
    });

    expect(getCatalogCapability).toHaveBeenCalledWith(CATALOG_ID, "user-1", {
      activeCatalogOnly: undefined,
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Download not permitted/i);
  });

  it("opts into inactive catalog lookups when requested", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canDownload: false,
      canViewTranscripts: true,
    });

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/transcript-export?mode=txt&includeInactive=true`
    );
    const response = await exportCatalogTranscripts(request, {
      params: Promise.resolve({ id: CATALOG_ID }),
    });

    expect(response.status).toBe(403);
    expect(getCatalogCapability).toHaveBeenCalledWith(CATALOG_ID, "user-1", {
      activeCatalogOnly: false,
    });
  });

  it("exports merged txt and skips missing transcripts", async () => {
    requireAuth.mockResolvedValue("user-1");
    getCatalogCapability.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canDownload: true,
      canViewTranscripts: true,
    });
    getRagBackendKey.mockReturnValue("faster-whisper/large-v3@silero_vad_v6");
    loadCatalogHashes.mockResolvedValue(new Set([HASH_A, HASH_B]));
    resolveTranscriptsPath.mockReturnValue(`/data/transcripts_${CATALOG_ID}`);
    prisma.audioMetadata.findMany.mockResolvedValue([
      {
        audioHash: HASH_A,
        dateYear: 1982,
        dateMonth: 7,
        dateDay: 4,
        location: { name: "Brno" },
      },
    ]);
    prisma.catalogEntry.findMany.mockResolvedValue([
      { audioHash: HASH_A, sourceDate: "1982-07-04" },
      { audioHash: HASH_B, sourceDate: "1980" },
    ]);
    readTranscriptFile.mockImplementation(
      async (_path: string, hash: string) => {
        if (hash === HASH_A) {
          return { content: "First transcript line\n", filename: "transcript.txt" };
        }
        return null;
      }
    );

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/transcript-export?mode=txt`
    );
    const response = await exportCatalogTranscripts(request, {
      params: Promise.resolve({ id: CATALOG_ID }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("content-disposition")).toContain(".txt");

    const text = await response.text();
    expect(text).toContain(`# Catalog: ${CATALOG_ID}`);
    expect(text).toContain("# Missing skipped: 1");
    expect(text).toContain(`===== 1982-07-04 | Brno | ${HASH_A} =====`);
    expect(text).not.toContain(`===== ${HASH_B} =====`);
    expect(text).toContain("First transcript line");
  });

  it("returns 400 for invalid mode", async () => {
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/transcript-export?mode=pdf`
    );
    const response = await exportCatalogTranscripts(request, {
      params: Promise.resolve({ id: CATALOG_ID }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Invalid mode/i);
  });
});
