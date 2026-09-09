import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as completeIngest } from "@/app/api/internal/ingest/[intakeId]/complete/route";

vi.mock("@/lib/config", () => ({
  getUploadsDir: () => "/data/uploads",
}));

vi.mock("@/lib/jobs-api/server", () => ({
  fetchJobsApi: vi.fn(),
  JobsApiConfigurationError: class JobsApiConfigurationError extends Error {},
  JobsApiError: class JobsApiError extends Error {},
}));

vi.mock("@/lib/catalog-sync", () => ({
  syncCatalogGroup: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingIntake: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const CATALOG_ID = "20260201_120000";
const INTAKE_ID = "cmf9abcdefghijklmnopqrstu";
const HASH = "b".repeat(64);
const originalEnv = process.env;

function request(body: unknown, token: string | null = "job-secret") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new NextRequest(`http://localhost/api/internal/ingest/${INTAKE_ID}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function row(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-09-08T10:00:00Z");
  return {
    id: INTAKE_ID,
    workflowGroupId: CATALOG_ID,
    requestedById: "admin-1",
    originalFilename: "talk.mp3",
    storedFilename: "source.mp3",
    mimeType: null,
    expectedSizeBytes: BigInt(10),
    receivedBytes: BigInt(10),
    receivedChunks: 1,
    status: "RUNNING",
    jobId: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
    audioHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    workflowGroup: { label: "Main" },
    requestedBy: { id: "admin-1", name: "Admin", email: null },
    ...overrides,
  };
}

describe("internal ingest completion route", () => {
  let syncCatalogGroup: ReturnType<typeof vi.fn>;
  let prisma: {
    recordingIntake: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, BESEDY_JOB_SERVICE_SECRET: "job-secret" };
    syncCatalogGroup = (await import("@/lib/catalog-sync")).syncCatalogGroup as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects a missing or wrong bearer token", async () => {
    const missing = await completeIngest(request({ status: "FAILED" }, null), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    const wrong = await completeIngest(request({ status: "FAILED" }, "nope"), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(prisma.recordingIntake.findUnique).not.toHaveBeenCalled();
  });

  it("marks success and re-syncs the catalog projection", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row());
    prisma.recordingIntake.update.mockResolvedValue(
      row({ status: "SUCCEEDED", audioHash: HASH, finishedAt: new Date() })
    );
    syncCatalogGroup.mockResolvedValue({
      groupId: CATALOG_ID,
      status: "success",
      changedSources: ["metadata"],
      rowCounts: { metadata: 12 },
    });

    const response = await completeIngest(
      request({ status: "SUCCEEDED", audioHash: HASH.toUpperCase() }),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      alreadyFinal: false,
      intake: { status: "SUCCEEDED", audioHash: HASH },
      sync: { status: "success" },
    });
    expect(prisma.recordingIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED", audioHash: HASH }),
      })
    );
    expect(syncCatalogGroup).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("records a rejection without syncing", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row());
    prisma.recordingIntake.update.mockResolvedValue(
      row({ status: "REJECTED", audioHash: HASH, errorCode: "duplicate" })
    );

    const response = await completeIngest(
      request({ status: "REJECTED", audioHash: HASH, errorCode: "duplicate", errorMessage: "dup" }),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(200);
    expect(syncCatalogGroup).not.toHaveBeenCalled();
    expect(prisma.recordingIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REJECTED", errorCode: "duplicate" }),
      })
    );
  });

  it("is idempotent for terminal intakes", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row({ status: "SUCCEEDED", audioHash: HASH }));

    const response = await completeIngest(request({ status: "SUCCEEDED", audioHash: HASH }), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, alreadyFinal: true });
    expect(prisma.recordingIntake.update).not.toHaveBeenCalled();
    expect(syncCatalogGroup).not.toHaveBeenCalled();
  });

  it("keeps SUCCEEDED but flags sync failures", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row());
    prisma.recordingIntake.update
      .mockResolvedValueOnce(row({ status: "SUCCEEDED", audioHash: HASH }))
      .mockResolvedValueOnce(
        row({ status: "SUCCEEDED", audioHash: HASH, errorCode: "sync_failed" })
      );
    syncCatalogGroup.mockResolvedValue({
      groupId: CATALOG_ID,
      status: "error",
      changedSources: [],
      rowCounts: {},
      error: "row count dropped",
    });

    const response = await completeIngest(request({ status: "SUCCEEDED", audioHash: HASH }), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: false,
      intake: { status: "SUCCEEDED", errorCode: "sync_failed" },
    });
    expect(prisma.recordingIntake.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: "sync_failed" }),
      })
    );
  });

  it("returns 404 for unknown intakes and 400 for invalid bodies", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(null);
    const missing = await completeIngest(request({ status: "FAILED" }), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    expect(missing.status).toBe(404);

    const invalid = await completeIngest(request({ status: "WHATEVER" }), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    expect(invalid.status).toBe(400);
  });
});
