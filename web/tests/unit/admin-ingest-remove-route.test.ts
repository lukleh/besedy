import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { POST as removeIntake } from "@/app/api/admin/ingest/[intakeId]/remove/route";
import { POST as completeIngest } from "@/app/api/internal/ingest/[intakeId]/complete/route";
import { GET as listIntakes } from "@/app/api/admin/ingest/route";

const mocks = vi.hoisted(() => ({
  uploadsDir: "",
}));

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: vi.fn(),
  AuthError: class AuthError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 403) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  getUploadsDir: () => mocks.uploadsDir,
}));

vi.mock("@/lib/jobs-api/server", () => ({
  fetchJobsApi: vi.fn(),
  JobsApiConfigurationError: class JobsApiConfigurationError extends Error {},
  JobsApiError: class JobsApiError extends Error {
    status: number;
    payload: unknown;

    constructor(message: string, status: number, payload: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  },
}));

vi.mock("@/lib/audit/logger", () => ({
  logContentEvent: vi.fn(),
}));

vi.mock("@/lib/catalog-sync", () => ({
  syncCatalogGroup: vi.fn(),
}));

vi.mock("@/lib/ingest/removal", () => ({
  removeRecordingWebState: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingIntake: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const CATALOG_ID = "20260201_120000";
const INTAKE_ID = "cmf9abcdefghijklmnopqrstu";
const JOB_ID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const REMOVAL_JOB_ID = "7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const HASH = "b".repeat(64);
const originalEnv = process.env;

function adminRequest(url: string, body: unknown = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

function workerRequest(intakeId: string, body: unknown) {
  return new NextRequest(`http://localhost/api/internal/ingest/${intakeId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer job-secret" },
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
    status: "SUCCEEDED",
    jobId: JOB_ID,
    audioHash: HASH,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    workflowGroup: { label: "Main" },
    requestedBy: { id: "admin-1", name: "Admin", email: null },
    ...overrides,
  };
}

describe("admin ingest removal", () => {
  let fetchJobsApi: ReturnType<typeof vi.fn>;
  let removeRecordingWebState: ReturnType<typeof vi.fn>;
  let syncCatalogGroup: ReturnType<typeof vi.fn>;
  let logContentEvent: ReturnType<typeof vi.fn>;
  let prisma: {
    recordingIntake: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, BESEDY_JOB_SERVICE_SECRET: "job-secret" };
    mocks.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-remove-"));

    const permissions = await import("@/lib/auth/permissions");
    (permissions.requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue("admin-1");
    const access = await import("@/lib/access/capabilities");
    (access.getAdminCapability as ReturnType<typeof vi.fn>).mockResolvedValue({
      canAccessAdmin: true,
    });
    fetchJobsApi = (await import("@/lib/jobs-api/server")).fetchJobsApi as ReturnType<typeof vi.fn>;
    removeRecordingWebState = (await import("@/lib/ingest/removal"))
      .removeRecordingWebState as ReturnType<typeof vi.fn>;
    syncCatalogGroup = (await import("@/lib/catalog-sync")).syncCatalogGroup as ReturnType<
      typeof vi.fn
    >;
    logContentEvent = (await import("@/lib/audit/logger")).logContentEvent as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
    removeRecordingWebState.mockResolvedValue({
      detachedEventId: 7,
      unreleasedEventId: 7,
      metadataDeleted: 1,
      progressDeleted: 2,
      notificationsDeleted: 0,
    });
    syncCatalogGroup.mockResolvedValue({
      groupId: CATALOG_ID,
      status: "success",
      changedSources: ["metadata"],
      rowCounts: {},
    });
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(mocks.uploadsDir, { recursive: true, force: true });
  });

  it("submits a removal job for a recording that reached the catalog", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row());
    prisma.recordingIntake.findUniqueOrThrow.mockResolvedValue(
      row({ status: "REMOVING", jobId: REMOVAL_JOB_ID, finishedAt: null })
    );
    fetchJobsApi.mockResolvedValue({
      id: REMOVAL_JOB_ID,
      kind: "INGEST",
      status: "QUEUED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: { intakeId: INTAKE_ID, audioHash: HASH, operation: "remove" },
    });

    const response = await removeIntake(adminRequest(`/api/admin/ingest/${INTAKE_ID}/remove`), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ intake: { status: "REMOVING", jobId: REMOVAL_JOB_ID } });
    expect(fetchJobsApi).toHaveBeenCalledWith(`/catalogs/${CATALOG_ID}/ingest/removals`, {
      method: "POST",
      body: { intakeId: INTAKE_ID, audioHash: HASH, requestedById: "admin-1" },
      schema: expect.anything(),
    });
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith({
      where: { id: INTAKE_ID, status: "SUCCEEDED" },
      data: {
        status: "REMOVING",
        jobId: REMOVAL_JOB_ID,
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
      },
    });
    expect(logContentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RECORDING_INGEST_REMOVED", resourceId: INTAKE_ID })
    );
  });

  it("only deletes upload files for a rejected duplicate and never touches the existing recording", async () => {
    const rejectedDir = path.join(mocks.uploadsDir, CATALOG_ID, "rejected", INTAKE_ID);
    await fs.mkdir(rejectedDir, { recursive: true });
    await fs.writeFile(path.join(rejectedDir, "source.mp3"), "dup");
    // REJECTED rows carry the hash of the *existing* recording they duplicated.
    prisma.recordingIntake.findUnique.mockResolvedValue(
      row({ status: "REJECTED", errorCode: "duplicate" })
    );
    prisma.recordingIntake.findUniqueOrThrow.mockResolvedValue(row({ status: "REMOVED" }));

    const response = await removeIntake(adminRequest(`/api/admin/ingest/${INTAKE_ID}/remove`), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ intake: { status: "REMOVED" } });
    expect(fetchJobsApi).not.toHaveBeenCalled();
    await expect(fs.stat(rejectedDir)).rejects.toThrow();
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTAKE_ID, status: "REJECTED" },
        data: expect.objectContaining({ status: "REMOVED" }),
      })
    );
  });

  it("refuses to remove active intakes and leaves state untouched when the jobs API is down", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(row({ status: "RUNNING" }));
    const active = await removeIntake(adminRequest(`/api/admin/ingest/${INTAKE_ID}/remove`), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    expect(active.status).toBe(409);

    prisma.recordingIntake.findUnique.mockResolvedValue(row());
    const { JobsApiError } = await import("@/lib/jobs-api/server");
    fetchJobsApi.mockRejectedValue(new JobsApiError("down", 503, null));
    const down = await removeIntake(adminRequest(`/api/admin/ingest/${INTAKE_ID}/remove`), {
      params: Promise.resolve({ intakeId: INTAKE_ID }),
    });
    expect(down.status).toBe(502);
    expect(prisma.recordingIntake.updateMany).not.toHaveBeenCalled();
  });

  it("completes a removal by deleting web-owned state and re-syncing", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(
      row({ status: "REMOVING", jobId: REMOVAL_JOB_ID })
    );
    prisma.recordingIntake.update.mockResolvedValue(row({ status: "REMOVED" }));

    const response = await completeIngest(
      workerRequest(INTAKE_ID, { status: "REMOVED", audioHash: HASH }),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      intake: { status: "REMOVED" },
      removal: { unreleasedEventId: 7 },
    });
    expect(prisma.recordingIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REMOVED", audioHash: HASH }),
      })
    );
    expect(removeRecordingWebState).toHaveBeenCalledWith(CATALOG_ID, HASH);
    expect(syncCatalogGroup).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("reconciles a REMOVING row whose worker run finished without a callback", async () => {
    const removing = row({ status: "REMOVING", jobId: REMOVAL_JOB_ID });
    prisma.recordingIntake.findMany.mockResolvedValue([removing]);
    prisma.recordingIntake.findUnique.mockResolvedValue(
      row({ status: "REMOVED", errorCode: "completion_missing" })
    );
    fetchJobsApi.mockResolvedValue({
      id: REMOVAL_JOB_ID,
      kind: "INGEST",
      status: "SUCCEEDED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: {},
    });

    const response = await listIntakes(new NextRequest("http://localhost/api/admin/ingest"));

    expect(response.status).toBe(200);
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTAKE_ID, status: "REMOVING" },
        data: expect.objectContaining({ status: "REMOVED", errorCode: "completion_missing" }),
      })
    );
    expect(removeRecordingWebState).toHaveBeenCalledWith(CATALOG_ID, HASH);
    expect(syncCatalogGroup).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("marks a failed removal run as remove_failed and keeps the hash", async () => {
    const removing = row({ status: "REMOVING", jobId: REMOVAL_JOB_ID });
    prisma.recordingIntake.findMany.mockResolvedValue([removing]);
    prisma.recordingIntake.findUnique.mockResolvedValue(
      row({ status: "FAILED", errorCode: "remove_failed" })
    );
    fetchJobsApi.mockResolvedValue({
      id: REMOVAL_JOB_ID,
      kind: "INGEST",
      status: "FAILED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: {},
      error_message: "catalog_remove exited with code 1",
    });

    await listIntakes(new NextRequest("http://localhost/api/admin/ingest"));

    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTAKE_ID, status: "REMOVING" },
        data: expect.objectContaining({ status: "FAILED", errorCode: "remove_failed" }),
      })
    );
    expect(removeRecordingWebState).not.toHaveBeenCalled();
  });
});
