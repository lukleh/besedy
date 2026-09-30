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
  mockRequireCatalogRecordingOriginalAudio,
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
    mockRequireCatalogRecordingOriginalAudio: vi.fn(),
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
  requireCatalogRecordingOriginalAudio: mockRequireCatalogRecordingOriginalAudio,
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
        canDownloadOriginalAudio: true,
      },
    });
    mockRequireCatalogRecordingAccess.mockResolvedValue(null);
    mockRequireCatalogRecordingDownload.mockResolvedValue(null);
    mockRequireCatalogRecordingOriginalAudio.mockResolvedValue(null);
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

  // The master belongs to no role. Asked whether or not the request forces a
  // download, because serving it inline delivers the same bytes.
  it.each([
    ["a download", "?source=original&download=true"],
    ["a plain request", "?source=original"],
  ])("refuses the original recording on %s without the permission", async (_name, query) => {
    mockResolveCatalogRecordingRouteAccess.mockResolvedValue({
      ok: true,
      userId: "user-1",
      catalogId: CATALOG_ID,
      hash: HASH,
      capability: {
        hasAccess: true,
        canAccessRecording: true,
        canDownloadRecording: true,
        canDownloadOriginalAudio: false,
      },
    });
    mockRequireCatalogRecordingOriginalAudio.mockResolvedValue(
      NextResponse.json({ error: "not available" }, { status: 403 })
    );

    const response = await getAudio(
      new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio${query}`
      ),
      { params: Promise.resolve({ id: CATALOG_ID, hash: HASH }) }
    );

    expect(response.status).toBe(403);
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
      }, undefined);

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
    }, undefined);
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
    }, undefined);
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

  it("returns a clear error without opening a stream when the file is not readable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const accessSpy = vi
      .spyOn(fs.promises, "access")
      .mockRejectedValue(
        Object.assign(new Error(`EACCES: permission denied, access '${audioPath}'`), {
          code: "EACCES",
        })
      );
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: { range: "bytes=0-" },
        }
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Audio file is not readable" });
      expect(createReadStreamSpy).not.toHaveBeenCalled();
      expect(mockLogAudioStreamed).not.toHaveBeenCalled();

      const event = findStructuredEvent(errorSpy.mock.calls as unknown[][], "audio_route_response");
      expect(event).toMatchObject({
        status: 500,
        reason: "audio_file_unreadable",
        errorName: "Error",
        errorCode: "EACCES",
      });
    } finally {
      errorSpy.mockRestore();
      accessSpy.mockRestore();
      createReadStreamSpy.mockRestore();
    }
  });

  it.each([
    { label: "range stream", query: "", range: "bytes=0-", status: 206, audit: mockLogAudioStreamed },
    { label: "full stream", query: "", range: null, status: 200, audit: mockLogAudioStreamed },
    { label: "range download", query: "?download=true", range: "bytes=0-", status: 206, audit: mockLogAudioDownloaded },
    { label: "full download", query: "?download=true", range: null, status: 200, audit: mockLogAudioDownloaded },
  ])("writes the audit log before opening the stream ($label)", async ({ query, range, status, audit }) => {
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio${query}`,
        range ? { headers: { range } } : undefined
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(status);
      // An open error that fires while an await is pending has no listener yet
      // and becomes an uncaught exception, so no await may sit in between.
      expect(audit).toHaveBeenCalledTimes(1);
      expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
      expect(audit.mock.invocationCallOrder[0]).toBeLessThan(
        createReadStreamSpy.mock.invocationCallOrder[0]
      );
      await response.arrayBuffer();
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it("returns 416 without an audit entry for an inverted range", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: { range: "bytes=100-50" },
        }
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe(`bytes */${FILE_SIZE}`);
      expect(mockLogAudioStreamed).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns a clear error without opening a stream when the path is a directory", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const createReadStreamSpy = vi.spyOn(fs, "createReadStream");
    mockGetCatalogEntry.mockResolvedValue({
      compressedPath: tmpDir,
      originalPath: tmpDir,
      isActionable: true,
    });
    mockValidatePathAsync.mockResolvedValue({ valid: true, resolvedPath: tmpDir });

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: "Audio file is not readable" });
      expect(createReadStreamSpy).not.toHaveBeenCalled();
      expect(mockLogAudioStreamed).not.toHaveBeenCalled();

      const event = findStructuredEvent(errorSpy.mock.calls as unknown[][], "audio_route_response");
      expect(event).toMatchObject({ status: 500, reason: "audio_file_not_regular" });
    } finally {
      errorSpy.mockRestore();
      createReadStreamSpy.mockRestore();
    }
  });

  it("returns 404 with the errno code when the file is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.rmSync(audioPath);

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Audio file not found on disk" });
      expect(mockLogAudioStreamed).not.toHaveBeenCalled();

      const event = findStructuredEvent(warnSpy.mock.calls as unknown[][], "audio_route_response");
      expect(event).toMatchObject({
        status: 404,
        reason: "audio_file_missing",
        errorCode: "ENOENT",
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns 416 without an audit entry for a suffix range on an empty file", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(audioPath, Buffer.alloc(0));

    try {
      const request = new NextRequest(
        `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
        {
          headers: { range: "bytes=-5" },
        }
      );
      const response = await getAudio(request, {
        params: Promise.resolve({ id: CATALOG_ID, hash: HASH }),
      });

      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */0");
      expect(mockLogAudioStreamed).not.toHaveBeenCalled();
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

  describe("format=aac", () => {
    let aacPath: string;

    beforeEach(() => {
      aacPath = path.join(tmpDir, "recording.m4a");
      fs.writeFileSync(aacPath, Buffer.alloc(2048, 3));
      mockGetCatalogEntry.mockResolvedValue({
        compressedPath: audioPath,
        compressedAacPath: aacPath,
        originalPath: audioPath,
        isActionable: true,
      });
      mockValidatePathAsync.mockImplementation(async (candidate: string) => ({
        valid: true,
        resolvedPath: candidate,
      }));
    });

    const request = (query: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
      getAudio(
        new NextRequest(
          `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?${query}`,
          init,
        ),
        { params: Promise.resolve({ id: CATALOG_ID, hash: HASH }) },
      );

    it("serves the AAC copy as audio/mp4 through the same path checks", async () => {
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await request("format=aac", { headers: { range: "bytes=0-99" } });

        expect(response.status).toBe(206);
        expect(response.headers.get("Content-Type")).toBe("audio/mp4");
        expect(response.headers.get("Content-Range")).toBe("bytes 0-99/2048");
        expect(mockRewritePath).toHaveBeenCalledWith(aacPath);
        expect(mockValidatePathAsync).toHaveBeenCalledWith(aacPath);
        const event = findStructuredEvent(infoSpy.mock.calls as unknown[][], "audio_route_response");
        expect(event).toMatchObject({ reason: "range_stream", format: "aac", servedSource: "archived" });
        expect(mockLogAudioStreamed).toHaveBeenCalledWith(
          "user-1",
          HASH,
          CATALOG_ID,
          { start: 0, end: 99, fileSize: 2048 },
          "aac"
        );
        await response.arrayBuffer();
      } finally {
        infoSpy.mockRestore();
      }
    });

    it("keeps serving the WebM without format or with format=webm", async () => {
      for (const query of ["", "format=webm"]) {
        const response = await request(query);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Length")).toBe(String(FILE_SIZE));
        await response.arrayBuffer();
      }
      expect(mockValidatePathAsync).not.toHaveBeenCalledWith(aacPath);
    });

    it("returns 404 instead of the WebM when there is no AAC copy", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        mockGetCatalogEntry.mockResolvedValue({
          compressedPath: audioPath,
          originalPath: audioPath,
          isActionable: true,
        });

        const response = await request("format=aac");

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "No AAC copy for this recording" });
        expect(mockValidatePathAsync).not.toHaveBeenCalled();
        expect(mockLogAudioStreamed).not.toHaveBeenCalled();
        const event = findStructuredEvent(warnSpy.mock.calls as unknown[][], "audio_route_response");
        expect(event).toMatchObject({ status: 404, reason: "aac_unavailable" });
      } finally {
        warnSpy.mockRestore();
      }
    });

    // The access checks come before the format is looked at; these pin that
    // order, so a later refactor cannot serve the copy to someone the WebM
    // would be refused to.
    it("denies the AAC copy when the recording is not accessible", async () => {
      mockRequireCatalogRecordingAccess.mockResolvedValue(
        NextResponse.json({ error: "Access denied to this recording" }, { status: 403 })
      );

      const response = await request("format=aac");

      expect(response.status).toBe(403);
      expect(mockGetCatalogEntry).not.toHaveBeenCalled();
      expect(mockValidatePathAsync).not.toHaveBeenCalled();
    });

    it("denies downloading the AAC copy without the download permission", async () => {
      mockRequireCatalogRecordingDownload.mockResolvedValue(
        NextResponse.json({ error: "Download not permitted for this recording" }, { status: 403 })
      );

      const response = await request("format=aac&download=true");

      expect(response.status).toBe(403);
      expect(mockGetCatalogEntry).not.toHaveBeenCalled();
    });

    it("downloads the AAC copy under its own file name and audits the download", async () => {
      const response = await request("format=aac&download=true");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("audio/mp4");
      expect(response.headers.get("Content-Disposition")).toContain('filename="recording.m4a"');
      expect(mockLogAudioDownloaded).toHaveBeenCalledWith(
        "user-1",
        HASH,
        CATALOG_ID,
        "archived",
        "aac"
      );
      await response.arrayBuffer();
    });

    it("rejects format=aac for the original recording", async () => {
      const response = await request("source=original&format=aac");
      expect(response.status).toBe(400);
      expect(mockGetCatalogEntry).not.toHaveBeenCalled();
    });

    it("rejects an unknown format", async () => {
      const response = await request("format=flac");
      expect(response.status).toBe(400);
    });

    it("serves the listening variant's own AAC copy", async () => {
      const listeningAac = path.join(tmpDir, "listening.m4a");
      fs.writeFileSync(listeningAac, Buffer.alloc(512, 4));
      mockPrisma.workflowVariant.findFirst.mockResolvedValue({
        variant: "enhanced",
        listeningArchivedCatalogPath: "/catalogs/listening.csv",
      });
      mockPrisma.catalogListeningEntry.findUnique.mockResolvedValue({
        compressedPath: path.join(tmpDir, "listening.webm"),
        compressedAacPath: listeningAac,
      });

      const response = await request("source=listening&format=aac");

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Length")).toBe("512");
      expect(mockValidatePathAsync).toHaveBeenCalledWith(listeningAac);
      await response.arrayBuffer();
    });

    it("does not substitute the archived AAC copy for a variant without one", async () => {
      mockPrisma.workflowVariant.findFirst.mockResolvedValue({
        variant: "enhanced",
        listeningArchivedCatalogPath: "/catalogs/listening.csv",
      });
      mockPrisma.catalogListeningEntry.findUnique.mockResolvedValue({
        compressedPath: path.join(tmpDir, "listening.webm"),
        compressedAacPath: null,
      });

      const response = await request("source=listening&format=aac");

      expect(response.status).toBe(404);
      expect(mockValidatePathAsync).not.toHaveBeenCalled();
    });

    it("uses the archived AAC copy when the variant has no row for the recording", async () => {
      mockPrisma.workflowVariant.findFirst.mockResolvedValue({
        variant: "enhanced",
        listeningArchivedCatalogPath: "/catalogs/listening.csv",
      });
      mockPrisma.catalogListeningEntry.findUnique.mockResolvedValue(null);

      const response = await request("source=listening&format=aac");

      expect(response.status).toBe(200);
      expect(mockValidatePathAsync).toHaveBeenCalledWith(aacPath);
      await response.arrayBuffer();
    });
  });
});
