import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { GET as getAudio } from "@/app/api/catalogs/[id]/recordings/[hash]/audio/route";

const CATALOG_ID = "20250101_120000";
const HASH = "a".repeat(64);
const FILE_SIZE = 3 * 1024 * 1024 + 123;

function findStructuredEvent(calls: unknown[][], eventName: string): Record<string, unknown> | null {
  for (const [firstArg] of calls) {
    if (typeof firstArg !== "string") continue;
    try {
      const parsed = JSON.parse(firstArg) as Record<string, unknown>;
      if (parsed.event === eventName) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return null;
}

const {
  mockResolveCatalogRecordingRouteAccess,
  mockRequireCatalogRecordingAccess,
  mockRequireCatalogRecordingDownload,
  mockGetCatalogEntry,
  mockLogAudioStreamed,
  mockLogAudioDownloaded,
  mockLogAccessDenied,
  mockValidatePathAsync,
  mockRewritePath,
  mockPrisma,
} = vi.hoisted(() => {
  const mockPrisma = {
    workflowVariant: {
      findFirst: vi.fn(),
    },
    catalogListeningEntry: {
      findUnique: vi.fn(),
    },
  };

  return {
    mockResolveCatalogRecordingRouteAccess: vi.fn(),
    mockRequireCatalogRecordingAccess: vi.fn(),
    mockRequireCatalogRecordingDownload: vi.fn(),
    mockGetCatalogEntry: vi.fn(),
    mockLogAudioStreamed: vi.fn(),
    mockLogAudioDownloaded: vi.fn(),
    mockLogAccessDenied: vi.fn(),
    mockValidatePathAsync: vi.fn(),
    mockRewritePath: vi.fn((input: string) => input),
    mockPrisma,
  };
});

vi.mock("@/lib/access/catalog-recording-route-access", () => ({
  resolveCatalogRecordingRouteAccess: mockResolveCatalogRecordingRouteAccess,
  requireCatalogRecordingAccess: mockRequireCatalogRecordingAccess,
  requireCatalogRecordingDownload: mockRequireCatalogRecordingDownload,
}));

vi.mock("@/lib/catalog", () => ({
  getCatalogEntry: mockGetCatalogEntry,
}));

vi.mock("@/lib/audit/logger", () => ({
  logAudioStreamed: mockLogAudioStreamed,
  logAudioDownloaded: mockLogAudioDownloaded,
  logAccessDenied: mockLogAccessDenied,
}));

vi.mock("@/lib/security/path-validation", () => ({
  validatePathAsync: mockValidatePathAsync,
  rewritePath: mockRewritePath,
}));

vi.mock("@/lib/db", () => ({
  default: mockPrisma,
  prisma: mockPrisma,
}));

describe("catalog audio route", () => {
  let tmpDir: string;
  let audioPath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "besedy-audio-route-"));
    audioPath = path.join(tmpDir, "recording.mp3");
    fs.writeFileSync(audioPath, Buffer.alloc(FILE_SIZE, 1));

    mockResolveCatalogRecordingRouteAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      catalogId: CATALOG_ID,
      hash: HASH,
      capability: {
        hasAccess: true,
        canAccessRecording: true,
        canDownloadRecording: true,
      },
    });
    mockRequireCatalogRecordingAccess.mockResolvedValue(null);
    mockRequireCatalogRecordingDownload.mockResolvedValue(null);
    mockGetCatalogEntry.mockResolvedValue({
      compressedPath: audioPath,
      originalPath: audioPath,
      isActionable: true,
    });
    mockValidatePathAsync.mockResolvedValue({
      valid: true,
      resolvedPath: audioPath,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("denies access before loading the catalog entry", async () => {
    mockRequireCatalogRecordingAccess.mockResolvedValue(
      NextResponse.json({ error: "Access denied to this recording" }, { status: 403 })
    );

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`
    );
    const response = await getAudio(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Access denied/);
    expect(mockGetCatalogEntry).not.toHaveBeenCalled();
  });

  it("denies download before touching filesystem when download is not allowed", async () => {
    mockRequireCatalogRecordingDownload.mockResolvedValue(
      NextResponse.json({ error: "Download not permitted for this recording" }, { status: 403 })
    );

    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?download=true`
    );
    const response = await getAudio(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/Download not permitted/);
    expect(mockGetCatalogEntry).not.toHaveBeenCalled();
  });

  it("streams the full file for requests without a range header", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: {
            "user-agent": "UnitTestBrowser/1.0",
          },
        }
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe(String(FILE_SIZE));
      expect(response.headers.get("Content-Range")).toBeNull();
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(mockLogAudioStreamed).toHaveBeenCalledWith("user-1", HASH, CATALOG_ID, {
        start: 0,
        end: FILE_SIZE - 1,
        fileSize: FILE_SIZE,
      });

      const event = findStructuredEvent(infoSpy.mock.calls as unknown[][], "audio_route_response");
      expect(event).toMatchObject({
        status: 200,
        reason: "full_stream",
        catalogId: CATALOG_ID,
        hash: HASH,
        requestedSource: "archived",
        servedSource: "archived",
        rangeHeader: null,
        userAgent: "UnitTestBrowser/1.0",
        fileSize: FILE_SIZE,
        responseBytes: FILE_SIZE,
      });
      expect(event?.handlerMs).toEqual(expect.any(Number));

      await response.arrayBuffer();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("honors open-ended range requests instead of truncating them to a fixed chunk", async () => {
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
      {
        headers: {
          range: "bytes=0-",
        },
      }
    );
    const response = await getAudio(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe(String(FILE_SIZE));
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
    expect(mockLogAudioStreamed).toHaveBeenCalledWith("user-1", HASH, CATALOG_ID, {
      start: 0,
      end: FILE_SIZE - 1,
      fileSize: FILE_SIZE,
    });
    await response.arrayBuffer();
  });

  it("serves the last N bytes for suffix ranges (bytes=-N)", async () => {
    const suffix = 1024;
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
      {
        headers: { range: `bytes=-${suffix}` },
      }
    );
    const response = await getAudio(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    const expectedStart = FILE_SIZE - suffix;
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe(String(suffix));
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${expectedStart}-${FILE_SIZE - 1}/${FILE_SIZE}`
    );
    expect(mockLogAudioStreamed).toHaveBeenCalledWith("user-1", HASH, CATALOG_ID, {
      start: expectedStart,
      end: FILE_SIZE - 1,
      fileSize: FILE_SIZE,
    });
    await response.arrayBuffer();
  });

  it("serves the whole file when the suffix is larger than the file", async () => {
    const request = new NextRequest(
      `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
      {
        headers: { range: `bytes=-${FILE_SIZE * 2}` },
      }
    );
    const response = await getAudio(request, {
      params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe(String(FILE_SIZE));
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${FILE_SIZE - 1}/${FILE_SIZE}`);
    await response.arrayBuffer();
  });

  it("returns 416 for a zero-length suffix range (bytes=-0)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: { range: "bytes=-0" },
        }
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe(`bytes */${FILE_SIZE}`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs invalid route parameter responses", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const request = new NextRequest("http://localhost/api/catalogs/not-a-timestamp/recordings/bad/audio");
      const response = await getAudio(request, {
        params: Promise.resolve({ id: "not-a-timestamp", hash: "bad" }),
      });

      expect(response.status).toBe(400);

      const event = findStructuredEvent(
        warnSpy.mock.calls as unknown[][],
        "audio_route_response"
      );
      expect(event).toMatchObject({
        status: 400,
        reason: "invalid_route_params",
        catalogId: "not-a-timestamp",
        hash: "bad",
      });
      expect(event?.handlerMs).toEqual(expect.any(Number));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("logs stream abort diagnostics when the request is cancelled", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const controller = new AbortController();
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: {
            "user-agent": "AbortTestBrowser/1.0",
          },
          signal: controller.signal,
        }
      );

      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });
      expect(response.status).toBe(200);

      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const responseEvent = findStructuredEvent(
        infoSpy.mock.calls as unknown[][],
        "audio_route_response"
      );
      expect(responseEvent).toMatchObject({
        status: 200,
        reason: "full_stream",
      });

      const abortEvent = findStructuredEvent(
        warnSpy.mock.calls as unknown[][],
        "audio_route_stream_abort"
      );
      expect(abortEvent).toMatchObject({
        catalogId: CATALOG_ID,
        hash: HASH,
        requestedSource: "archived",
        servedSource: "archived",
        rangeHeader: null,
        userAgent: "AbortTestBrowser/1.0",
      });
      expect(abortEvent?.bytesRead).toEqual(expect.any(Number));
      expect(abortEvent?.elapsedMs).toEqual(expect.any(Number));
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs already-aborted requests before stream hookup", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const controller = new AbortController();
      controller.abort();

      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: {
            "user-agent": "PreAbortBrowser/1.0",
          },
          signal: controller.signal,
        }
      );

      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });
      expect(response.status).toBe(200);

      const responseEvent = findStructuredEvent(
        infoSpy.mock.calls as unknown[][],
        "audio_route_response"
      );
      expect(responseEvent).toMatchObject({
        status: 200,
        reason: "full_stream",
      });

      const abortEvent = findStructuredEvent(
        warnSpy.mock.calls as unknown[][],
        "audio_route_stream_abort"
      );
      expect(abortEvent).toMatchObject({
        catalogId: CATALOG_ID,
        hash: HASH,
        requestedSource: "archived",
        servedSource: "archived",
        userAgent: "PreAbortBrowser/1.0",
      });
      expect(abortEvent?.elapsedMs).toEqual(expect.any(Number));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("logs the resolved listening variant when serving listening audio", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const listeningPath = path.join(tmpDir, "listening.mp3");
      fs.writeFileSync(listeningPath, Buffer.alloc(FILE_SIZE, 2));

      mockPrisma.workflowVariant.findFirst.mockResolvedValue({
        variant: "enhanced-default",
        listeningArchivedCatalogPath: "/catalogs/listening.csv",
      });
      mockPrisma.catalogListeningEntry.findUnique.mockResolvedValue({
        compressedPath: listeningPath,
      });

      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening`
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(200);

      const event = findStructuredEvent(infoSpy.mock.calls as unknown[][], "audio_route_response");
      expect(event).toMatchObject({
        status: 200,
        reason: "full_stream",
        requestedSource: "listening",
        servedSource: "listening",
        variant: "enhanced-default",
      });
      await response.arrayBuffer();
    } finally {
      infoSpy.mockRestore();
    }
  });
});
