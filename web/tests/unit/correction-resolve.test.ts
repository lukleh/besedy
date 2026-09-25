import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: {
    catalogEventRecording: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    transcriptWorkspace: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

const CATALOG_ID = "20260101_000000";
const PRIMARY = "a".repeat(64);
const SECONDARY = "b".repeat(64);

describe("transcript source resolution", () => {
  let prisma: {
    catalogEventRecording: {
      findUnique: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    transcriptWorkspace: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  let resolve: typeof import("@/lib/correction/resolve");

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as never;
    resolve = await import("@/lib/correction/resolve");
  });

  function primaryRecording(isPrimary: boolean) {
    prisma.catalogEventRecording.findUnique.mockResolvedValue(
      isPrimary ? { isPrimary: true } : null
    );
  }

  describe("the reader", () => {
    it("serves the machine transcript for a recording outside correction scope", async () => {
      primaryRecording(false);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue(null);

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, SECONDARY)
      ).resolves.toEqual({ kind: "machine" });
    });

    // The gate follows the workspace, not the current event assignment.
    // Detaching a recording, or promoting a different one, must not swap a
    // published corrected transcript back to the machine text underneath it.
    it("keeps serving the publication after the recording stops being primary", async () => {
      primaryRecording(false);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: "pub-1",
        searchPublicationId: "pub-1",
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
    });

    it("keeps withholding after demotion when correction is still under way", async () => {
      primaryRecording(false);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: null,
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "withheld", workspaceId: "ws-1" });
    });

    it("withholds text for an eligible recording that was never corrected", async () => {
      primaryRecording(true);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue(null);

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "withheld", workspaceId: null });
    });

    it("ignores an activation, because the reader pointer moves only on success", async () => {
      primaryRecording(true);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: null,
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "withheld", workspaceId: "ws-1" });
    });

    it("withholds text while correction is under way", async () => {
      primaryRecording(true);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: null,
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "withheld", workspaceId: "ws-1" });
    });

    it("serves the publication once one is active", async () => {
      primaryRecording(true);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: "pub-1",
        searchPublicationId: "pub-1",
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
    });

    it("withholds text again after an unpublish", async () => {
      primaryRecording(true);
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: "pub-1",
      });

      await expect(
        resolve.resolveReaderTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "withheld", workspaceId: "ws-1" });
    });
  });

  describe("search and MCP", () => {
    it("use the machine transcript before the first publication", async () => {
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: null,
      });

      await expect(
        resolve.resolveSearchTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "machine" });
    });

    it("keep the corrected snapshot after an ordinary unpublish", async () => {
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        readerPublicationId: null,
        searchPublicationId: "pub-1",
      });

      await expect(
        resolve.resolveSearchTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
    });

    it("do not ask whether the recording is correction-eligible", async () => {
      prisma.transcriptWorkspace.findFirst.mockResolvedValue(null);

      await resolve.resolveSearchTranscriptSource(CATALOG_ID, SECONDARY);

      expect(prisma.catalogEventRecording.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("privileged original access", () => {
    it("is the configured machine transcript before a workspace exists", async () => {
      prisma.transcriptWorkspace.findFirst.mockResolvedValue(null);

      await expect(
        resolve.resolveOriginalTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({ kind: "machine" });
    });

    it("is the frozen source once correction has started, published or not", async () => {
      prisma.transcriptWorkspace.findFirst.mockResolvedValue({
        id: "ws-1",
        sourceBackend: "faster-whisper/large-v3",
      });

      await expect(
        resolve.resolveOriginalTranscriptSource(CATALOG_ID, PRIMARY)
      ).resolves.toEqual({
        kind: "frozen",
        workspaceId: "ws-1",
        backend: "faster-whisper/large-v3",
      });
    });
  });

  describe("the bulk export", () => {
    it("resolves each recording the way the reader would", async () => {
      prisma.catalogEventRecording.findMany.mockResolvedValue([
        { audioHash: PRIMARY },
      ]);
      prisma.transcriptWorkspace.findMany.mockResolvedValue([
        { id: "ws-1", audioHash: PRIMARY, readerPublicationId: "pub-1" },
      ]);

      const resolved = await resolve.resolveReaderTranscriptSources(CATALOG_ID, [
        PRIMARY,
        SECONDARY,
      ]);

      expect(resolved.get(PRIMARY)).toEqual({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
      expect(resolved.get(SECONDARY)).toEqual({ kind: "machine" });
    });

    it("keeps a demoted recording's publication in the export", async () => {
      prisma.catalogEventRecording.findMany.mockResolvedValue([]);
      prisma.transcriptWorkspace.findMany.mockResolvedValue([
        { id: "ws-1", audioHash: PRIMARY, readerPublicationId: "pub-1" },
      ]);

      const resolved = await resolve.resolveReaderTranscriptSources(CATALOG_ID, [
        PRIMARY,
      ]);

      expect(resolved.get(PRIMARY)).toEqual({
        kind: "publication",
        workspaceId: "ws-1",
        publicationId: "pub-1",
      });
    });

    it("withholds an eligible recording with no reader publication", async () => {
      prisma.catalogEventRecording.findMany.mockResolvedValue([
        { audioHash: PRIMARY },
      ]);
      prisma.transcriptWorkspace.findMany.mockResolvedValue([]);

      const resolved = await resolve.resolveReaderTranscriptSources(CATALOG_ID, [
        PRIMARY,
      ]);

      expect(resolved.get(PRIMARY)).toEqual({ kind: "withheld", workspaceId: null });
    });

    it("asks nothing of the database for an empty catalog", async () => {
      const resolved = await resolve.resolveReaderTranscriptSources(CATALOG_ID, []);

      expect(resolved.size).toBe(0);
      expect(prisma.catalogEventRecording.findMany).not.toHaveBeenCalled();
      expect(prisma.transcriptWorkspace.findMany).not.toHaveBeenCalled();
    });
  });
});
