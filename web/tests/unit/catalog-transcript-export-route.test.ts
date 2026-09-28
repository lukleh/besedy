import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as exportCatalogTranscripts } from "@/app/api/catalogs/[id]/transcript-export/route";

// Correction resolution is exercised in its own tests; these route tests cover
// recordings outside correction scope, where the machine transcript is served.
vi.mock("@/lib/correction/resolve", () => ({
  resolveReaderTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveSearchTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveOriginalTranscriptSource: vi.fn(async () => ({ kind: "machine" })),
  resolveReaderTranscriptSources: vi.fn(async (_catalogId, hashes) => {
    const map = new Map();
    for (const hash of hashes) map.set(hash, { kind: "machine" });
    return map;
  }),
  publicationArtifactPath: vi.fn(() => "/tmp/publication/transcript.json"),
  frozenSourcePath: vi.fn(() => "/tmp/workspace/source/transcript.json"),
}));

vi.mock("@/lib/correction/reader-transcript", () => ({
  readPublishedTranscriptFile: vi.fn(),
}));

vi.mock("@/lib/correction/source", () => ({
  resolveConfiguredDefaultBackend: vi.fn(async () => null),
}));

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
  loadVisibleCatalogHashes: vi.fn(),
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
  let loadVisibleCatalogHashes: ReturnType<typeof vi.fn>;
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
    loadVisibleCatalogHashes = (await import("@/lib/catalog")).loadVisibleCatalogHashes as ReturnType<
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
      canBulkExportTranscripts: false,
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
      canBulkExportTranscripts: false,
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
      canBulkExportTranscripts: true,
      canViewTranscripts: true,
    });
    getRagBackendKey.mockReturnValue("faster-whisper/large-v3@silero_vad_v6");
    loadVisibleCatalogHashes.mockResolvedValue(new Set([HASH_A, HASH_B]));
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

describe("catalog transcript export under the reading gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const CATALOG = "20251225_120000";
  const HASH_A = "a".repeat(64);
  const HASH_B = "b".repeat(64);

  async function arrange() {
    const { requireAuth } = await import("@/lib/auth/permissions");
    const { getCatalogCapability } = await import("@/lib/access/capabilities");
    const { loadVisibleCatalogHashes } = await import("@/lib/catalog");
    const { resolveTranscriptsPath } = await import("@/lib/paths");
    const { getRagBackendKey } = await import("@/lib/runtime-config");
    const prisma = (await import("@/lib/db")).default as unknown as {
      audioMetadata: { findMany: ReturnType<typeof vi.fn> };
      catalogEntry: { findMany: ReturnType<typeof vi.fn> };
    };
    vi.mocked(requireAuth).mockResolvedValue("user-1");
    vi.mocked(getCatalogCapability).mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canBulkExportTranscripts: true,
      canViewTranscripts: true,
    } as never);
    vi.mocked(getRagBackendKey).mockReturnValue("faster-whisper/large-v3@silero_vad_v6");
    vi.mocked(loadVisibleCatalogHashes).mockResolvedValue(new Set([HASH_A, HASH_B]));
    vi.mocked(resolveTranscriptsPath).mockReturnValue(`/data/transcripts_${CATALOG}`);
    prisma.audioMetadata.findMany.mockResolvedValue([]);
    prisma.catalogEntry.findMany.mockResolvedValue([]);
  }

  function run() {
    return exportCatalogTranscripts(
      new NextRequest(`http://localhost/api/catalogs/${CATALOG}/transcript-export?mode=txt`),
      { params: Promise.resolve({ id: CATALOG }) }
    );
  }

  // The export is what the account can read: a recording in correction scope
  // contributes its publication, or nothing until one exists.
  it("exports a published correction and withholds an unpublished one", async () => {
    await arrange();
    const { resolveReaderTranscriptSources } = await import("@/lib/correction/resolve");
    const { readPublishedTranscriptFile } = await import("@/lib/correction/reader-transcript");
    const { readTranscriptFile } = await import("@/lib/transcript");
    vi.mocked(resolveReaderTranscriptSources).mockResolvedValueOnce(
      new Map([
        [HASH_A, { kind: "publication", workspaceId: "ws-1", publicationId: "pub-1" }],
        [HASH_B, { kind: "withheld", workspaceId: null }],
      ])
    );
    vi.mocked(readPublishedTranscriptFile).mockResolvedValue({
      content: "Corrected words\n",
      filename: "transcript.txt",
    });

    const response = await run();

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Corrected words");
    expect(text).not.toContain(`===== ${HASH_B}`);
    expect(readTranscriptFile).not.toHaveBeenCalled();
  });

  it("explains an empty export when every primary recording is unpublished", async () => {
    await arrange();
    const { resolveReaderTranscriptSources } = await import("@/lib/correction/resolve");
    vi.mocked(resolveReaderTranscriptSources).mockResolvedValueOnce(
      new Map([
        [HASH_A, { kind: "withheld", workspaceId: "ws-1" }],
        [HASH_B, { kind: "withheld", workspaceId: null }],
      ])
    );

    const response = await run();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/2 primary recording\(s\) are being corrected/),
    });
  });

  // A recording without the search backend's transcript is still readable
  // through the priority fallback, so the export carries it the same way.
  it("falls back to the reader's default backend when the search backend's file is missing", async () => {
    await arrange();
    const { readTranscriptFile } = await import("@/lib/transcript");
    const { resolveConfiguredDefaultBackend } = await import("@/lib/correction/source");
    vi.mocked(resolveConfiguredDefaultBackend).mockResolvedValue("whisperx/large-v3@pyannote_v3");
    vi.mocked(readTranscriptFile).mockImplementation(async (_path, _hash, backend) =>
      backend === "whisperx/large-v3@pyannote_v3"
        ? { content: "Fallback words\n", filename: "transcript.txt" }
        : null
    );

    const response = await run();

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Fallback words");
  });
});
