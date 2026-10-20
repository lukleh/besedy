import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: {
    transcriptWorkspace: { findMany: vi.fn() },
    transcriptSpan: { findMany: vi.fn() },
    transcriptSpanDecision: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/correction/span-summaries", () => ({ loadSpanSummaries: vi.fn() }));
vi.mock("@/lib/correction/flag-service", () => ({ loadSpanFlags: vi.fn() }));

const CATALOG_ID = "20260101_000000";
const AUDIO_HASH = "a".repeat(64);
const WORKSPACE = {
  id: "w1",
  audioHash: AUDIO_HASH,
  sourceBackend: "faster-whisper/large-v3@silero_vad_v6@lang-cs",
  sourceFingerprint: "f".repeat(64),
  segmentationVersion: "chunks-v1",
  stagedAudioPath: "/audio/a.wav",
  stagedAudioSize: BigInt(1234),
  stagedAudioSha256: "e".repeat(64),
};

type Mocked = ReturnType<typeof vi.fn>;

interface SpanSetup {
  id: string;
  ordinal: number;
  chunk: number | null;
  regions?: [number, number];
  state?: "done" | "needs_second_approval" | "not_reviewed" | "needs_attention";
  approvers?: string[];
  /** null: a span without a current revision */
  revision?: string | null;
  text?: string;
}

interface Decision {
  revisionId: string;
  actorKey: string;
  heardFraction: number | null;
}

// The eligibility rules of ADR 0012 against mocked loaders; what the loaders
// themselves return from a real database is `npm run test:correction-smoke`.
describe("buildTrainingExport", () => {
  let prisma: {
    transcriptWorkspace: { findMany: Mocked };
    transcriptSpan: { findMany: Mocked };
    transcriptSpanDecision: { findMany: Mocked };
  };
  let loadSpanSummaries: Mocked;
  let loadSpanFlags: Mocked;
  let buildTrainingExport: typeof import("@/lib/correction/training-export").buildTrainingExport;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    loadSpanSummaries = (await import("@/lib/correction/span-summaries"))
      .loadSpanSummaries as unknown as Mocked;
    loadSpanFlags = (await import("@/lib/correction/flag-service")).loadSpanFlags as unknown as Mocked;
    ({ buildTrainingExport } = await import("@/lib/correction/training-export"));
    prisma.transcriptWorkspace.findMany.mockResolvedValue([WORKSPACE]);
    loadSpanFlags.mockResolvedValue(new Map());
    prisma.transcriptSpanDecision.findMany.mockResolvedValue([]);
  });

  /** Spans as the summaries loader and the placement query return them; approvals fully heard unless given. */
  function spans(setup: SpanSetup[], decisions?: Decision[]) {
    loadSpanSummaries.mockResolvedValue(
      setup.map((span) => ({
        id: span.id,
        ordinal: span.ordinal,
        currentRevision:
          span.revision === null
            ? null
            : { id: span.revision ?? `rev-${span.id}`, text: span.text ?? `text ${span.id}` },
        summary: {
          state: span.state ?? "done",
          approverIds: span.approvers ?? ["alice", "bob"],
          disapproverIds: [],
          isDone: (span.state ?? "done") === "done",
        },
      }))
    );
    prisma.transcriptSpan.findMany.mockResolvedValue(
      setup.map((span) => ({
        id: span.id,
        chunkOrdinal: span.chunk,
        firstRegionIndex: span.regions?.[0] ?? null,
        lastRegionIndex: span.regions?.[1] ?? null,
      }))
    );
    prisma.transcriptSpanDecision.findMany.mockResolvedValue(
      decisions ??
        setup.flatMap((span) =>
          (span.approvers ?? ["alice", "bob"]).map((actorKey) => ({
            revisionId: span.revision ?? `rev-${span.id}`,
            actorKey,
            heardFraction: 1,
          }))
        )
    );
  }

  it("asks only for active workspaces cut under the contract, of the given catalog", async () => {
    spans([]);
    await buildTrainingExport(CATALOG_ID);
    expect(prisma.transcriptWorkspace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowGroupId: CATALOG_ID, status: "ACTIVE", segmentationVersion: { not: null } },
      })
    );
  });

  it("limits the export to one recording when asked", async () => {
    spans([]);
    await buildTrainingExport(CATALOG_ID, undefined, { audioHash: AUDIO_HASH });
    expect(prisma.transcriptWorkspace.findMany.mock.calls[0][0].where).toMatchObject({
      audioHash: AUDIO_HASH,
    });
  });

  it("exports a chunk of done, unflagged, listened-to spans with its provenance", async () => {
    spans([
      { id: "s0", ordinal: 0, chunk: 0, regions: [0, 1], text: "Dobrý den." },
      { id: "s1", ordinal: 1, chunk: 0, regions: [2, 2], text: "Vítejte." },
    ]);
    const result = await buildTrainingExport(CATALOG_ID);

    expect(result).toMatchObject({
      schemaVersion: 1,
      catalogId: CATALOG_ID,
      policy: { minHeardFraction: 0.9 },
    });
    expect(result.workspaces).toHaveLength(1);
    const [workspace] = result.workspaces;
    expect(workspace).toMatchObject({
      workspaceId: "w1",
      audioHash: AUDIO_HASH,
      segmentationVersion: "chunks-v1",
      stagedAudio: { path: "/audio/a.wav", size: 1234, sha256: "e".repeat(64) },
    });
    expect(workspace.chunks).toEqual([
      {
        chunk: 0,
        eligible: true,
        reasons: [],
        spans: [
          { spanId: "s0", ordinal: 0, revisionId: "rev-s0", text: "Dobrý den.", firstRegion: 0, lastRegion: 1 },
          { spanId: "s1", ordinal: 1, revisionId: "rev-s1", text: "Vítejte.", firstRegion: 2, lastRegion: 2 },
        ],
      },
    ]);
    expect(prisma.transcriptSpanDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { revisionId: { in: ["rev-s0", "rev-s1"] }, kind: "APPROVE" } })
    );
  });

  it("excludes the whole chunk when one span is not done", async () => {
    spans([
      { id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] },
      {
        id: "s1",
        ordinal: 1,
        chunk: 0,
        regions: [1, 1],
        state: "needs_second_approval",
        approvers: ["alice"],
      },
    ]);
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks[0].eligible).toBe(false);
    expect(workspace.chunks[0].reasons).toEqual(["span 1 is needs_second_approval"]);
    expect(workspace.chunks[0].spans).toHaveLength(2);
  });

  it("excludes a chunk with a current flag and names the flag", async () => {
    spans([{ id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] }]);
    loadSpanFlags.mockResolvedValue(
      new Map([["s0", [{ kind: "UNCLEAR" }, { kind: "FOREIGN_LANGUAGE" }]]])
    );
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks[0]).toMatchObject({
      eligible: false,
      reasons: ["span 0 is flagged UNCLEAR, FOREIGN_LANGUAGE"],
    });
  });

  it("excludes an approval given without listening enough", async () => {
    spans(
      [{ id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] }],
      [
        { revisionId: "rev-s0", actorKey: "alice", heardFraction: 1 },
        { revisionId: "rev-s0", actorKey: "bob", heardFraction: 0.5 },
      ]
    );
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks[0].reasons).toEqual(["span 0 has an approval without listening"]);
  });

  it("excludes an approver whose playback was never reported", async () => {
    spans(
      [{ id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] }],
      [{ revisionId: "rev-s0", actorKey: "alice", heardFraction: 1 }]
    );
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks[0].eligible).toBe(false);
  });

  it("counts the latest approval of a person who withdrew and approved again", async () => {
    // Decisions arrive in write order; the later, fully heard approval stands.
    spans(
      [{ id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] }],
      [
        { revisionId: "rev-s0", actorKey: "alice", heardFraction: 0.2 },
        { revisionId: "rev-s0", actorKey: "bob", heardFraction: 1 },
        { revisionId: "rev-s0", actorKey: "alice", heardFraction: 0.95 },
      ]
    );
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks[0].eligible).toBe(true);
    expect(prisma.transcriptSpanDecision.findMany.mock.calls[0][0].orderBy).toEqual({
      sequence: "asc",
    });
  });

  it("applies the threshold it is given", async () => {
    spans(
      [{ id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] }],
      [
        { revisionId: "rev-s0", actorKey: "alice", heardFraction: 0.5 },
        { revisionId: "rev-s0", actorKey: "bob", heardFraction: 0.5 },
      ]
    );
    const result = await buildTrainingExport(CATALOG_ID, { minHeardFraction: 0.5 });
    expect(result.policy).toEqual({ minHeardFraction: 0.5 });
    expect(result.workspaces[0].chunks[0].eligible).toBe(true);
  });

  it("leaves out spans from before the contract and spans without a revision", async () => {
    spans([
      { id: "pre", ordinal: 0, chunk: null },
      { id: "bare", ordinal: 1, chunk: 0, regions: [0, 0], revision: null },
      { id: "s2", ordinal: 2, chunk: 1, regions: [1, 1] },
    ]);
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks.map((chunk) => chunk.chunk)).toEqual([1]);
    expect(workspace.chunks[0].spans.map((span) => span.spanId)).toEqual(["s2"]);
  });

  it("orders chunks by ordinal however the spans arrive", async () => {
    spans([
      { id: "s3", ordinal: 3, chunk: 2, regions: [4, 4] },
      { id: "s0", ordinal: 0, chunk: 0, regions: [0, 0] },
      { id: "s2", ordinal: 2, chunk: 1, regions: [2, 3] },
      { id: "s1", ordinal: 1, chunk: 0, regions: [1, 1] },
    ]);
    const [workspace] = (await buildTrainingExport(CATALOG_ID)).workspaces;
    expect(workspace.chunks.map((chunk) => chunk.chunk)).toEqual([0, 1, 2]);
    expect(workspace.chunks[0].spans.map((span) => span.ordinal)).toEqual([0, 1]);
  });
});
