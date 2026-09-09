import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { GET as listIntakes } from "@/app/api/admin/ingest/route";
import { POST as createUpload } from "@/app/api/admin/ingest/uploads/route";
import { DELETE as abortUpload } from "@/app/api/admin/ingest/uploads/[intakeId]/route";
import { PUT as putChunk } from "@/app/api/admin/ingest/uploads/[intakeId]/chunks/[index]/route";
import { POST as finalizeUpload } from "@/app/api/admin/ingest/uploads/[intakeId]/finalize/route";
import { parseUndeliveredOutcome } from "@/lib/ingest/server";

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
  getTextDataDir: () => {
    throw new Error("not configured");
  },
  getPostersDir: () => {
    throw new Error("not configured");
  },
  getSourcesDir: () => {
    throw new Error("not configured");
  },
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

vi.mock("@/lib/db", () => ({
  default: {
    workflowGroup: { findFirst: vi.fn() },
    recordingIntake: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const CATALOG_ID = "20260201_120000";
const INTAKE_ID = "cmf9abcdefghijklmnopqrstu";
const JOB_ID = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";

interface MutationRequestInit {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function mutationRequest(url: string, init: MutationRequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", "http://localhost");
  return new NextRequest(`http://localhost${url}`, {
    method: init.method,
    body: init.body,
    headers,
  });
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return mutationRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function baseRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-09-08T10:00:00Z");
  return {
    id: INTAKE_ID,
    workflowGroupId: CATALOG_ID,
    requestedById: "admin-1",
    originalFilename: "talk.mp3",
    storedFilename: "source.mp3",
    mimeType: "audio/mpeg",
    expectedSizeBytes: BigInt(10),
    receivedBytes: BigInt(0),
    receivedChunks: 0,
    status: "UPLOADING",
    jobId: null,
    audioHash: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    workflowGroup: { label: "Main" },
    requestedBy: { id: "admin-1", name: "Admin", email: "admin@besedy.test" },
    ...overrides,
  };
}

describe("admin ingest routes", () => {
  let requireAuth: ReturnType<typeof vi.fn>;
  let getAdminCapability: ReturnType<typeof vi.fn>;
  let fetchJobsApi: ReturnType<typeof vi.fn>;
  let logContentEvent: ReturnType<typeof vi.fn>;
  let syncCatalogGroup: ReturnType<typeof vi.fn>;
  let prisma: {
    workflowGroup: { findFirst: ReturnType<typeof vi.fn> };
    recordingIntake: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      findUniqueOrThrow: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-ingest-"));
    process.env.BESEDY_ALLOWED_PATHS = mocks.uploadsDir;

    requireAuth = (await import("@/lib/auth/permissions")).requireAuth as ReturnType<typeof vi.fn>;
    getAdminCapability = (await import("@/lib/access/capabilities"))
      .getAdminCapability as ReturnType<typeof vi.fn>;
    fetchJobsApi = (await import("@/lib/jobs-api/server")).fetchJobsApi as ReturnType<typeof vi.fn>;
    logContentEvent = (await import("@/lib/audit/logger")).logContentEvent as ReturnType<
      typeof vi.fn
    >;
    syncCatalogGroup = (await import("@/lib/catalog-sync")).syncCatalogGroup as ReturnType<
      typeof vi.fn
    >;
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;

    requireAuth.mockResolvedValue("admin-1");
    getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
  });

  afterEach(async () => {
    await fs.rm(mocks.uploadsDir, { recursive: true, force: true });
    delete process.env.BESEDY_ALLOWED_PATHS;
  });

  it("rejects non-admins on every route", async () => {
    getAdminCapability.mockResolvedValue({ canAccessAdmin: false });

    const responses = await Promise.all([
      listIntakes(new NextRequest("http://localhost/api/admin/ingest")),
      createUpload(
        jsonRequest("/api/admin/ingest/uploads", {
          catalogId: CATALOG_ID,
          filename: "talk.mp3",
          sizeBytes: 10,
        })
      ),
      putChunk(mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/chunks/0`, {
        method: "PUT",
        body: "abc",
      }), { params: Promise.resolve({ intakeId: INTAKE_ID, index: "0" }) }),
      finalizeUpload(jsonRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/finalize`, {}), {
        params: Promise.resolve({ intakeId: INTAKE_ID }),
      }),
      abortUpload(mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}`, { method: "DELETE" }), {
        params: Promise.resolve({ intakeId: INTAKE_ID }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(prisma.recordingIntake.create).not.toHaveBeenCalled();
  });

  it("creates an upload with its incoming directory and empty file", async () => {
    prisma.workflowGroup.findFirst.mockResolvedValue({ id: CATALOG_ID });
    prisma.recordingIntake.create.mockResolvedValue(baseRow());

    const response = await createUpload(
      jsonRequest("/api/admin/ingest/uploads", {
        catalogId: CATALOG_ID,
        filename: "talk.mp3",
        sizeBytes: 10,
        mimeType: "audio/mpeg",
      })
    );

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toMatchObject({ intakeId: INTAKE_ID, chunkSizeBytes: 50_000_000 });
    expect(prisma.recordingIntake.create).toHaveBeenCalledWith({
      data: {
        workflowGroupId: CATALOG_ID,
        requestedById: "admin-1",
        originalFilename: "talk.mp3",
        storedFilename: "source.mp3",
        mimeType: "audio/mpeg",
        expectedSizeBytes: BigInt(10),
      },
    });
    const stat = await fs.stat(
      path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID, "source.mp3")
    );
    expect(stat.size).toBe(0);
    // Every created level must be writable by the host worker (a different UID).
    for (const dir of [
      path.join(mocks.uploadsDir, CATALOG_ID),
      path.join(mocks.uploadsDir, CATALOG_ID, "incoming"),
      path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID),
    ]) {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o777);
    }
  });

  it("rejects unsupported extensions, oversized files and inactive catalogs", async () => {
    const badExt = await createUpload(
      jsonRequest("/api/admin/ingest/uploads", {
        catalogId: CATALOG_ID,
        filename: "notes.txt",
        sizeBytes: 10,
      })
    );
    expect(badExt.status).toBe(400);

    process.env.INGEST_MAX_UPLOAD_BYTES = "5";
    const tooLarge = await createUpload(
      jsonRequest("/api/admin/ingest/uploads", {
        catalogId: CATALOG_ID,
        filename: "talk.mp3",
        sizeBytes: 10,
      })
    );
    expect(tooLarge.status).toBe(413);
    delete process.env.INGEST_MAX_UPLOAD_BYTES;

    prisma.workflowGroup.findFirst.mockResolvedValue(null);
    const inactive = await createUpload(
      jsonRequest("/api/admin/ingest/uploads", {
        catalogId: CATALOG_ID,
        filename: "talk.mp3",
        sizeBytes: 10,
      })
    );
    expect(inactive.status).toBe(400);
    expect(prisma.recordingIntake.create).not.toHaveBeenCalled();
  });

  it("appends sequential chunks and rejects out-of-order or oversized ones", async () => {
    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "source.mp3");
    await fs.writeFile(filePath, "");

    prisma.recordingIntake.findUnique.mockResolvedValue(baseRow());
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });

    const first = await putChunk(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/chunks/0`, {
        method: "PUT",
        body: "hello",
      }),
      { params: Promise.resolve({ intakeId: INTAKE_ID, index: "0" }) }
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ intakeId: INTAKE_ID, receivedBytes: 5, receivedChunks: 1 });
    expect(await fs.readFile(filePath, "utf8")).toBe("hello");
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith({
      where: { id: INTAKE_ID, status: "UPLOADING", receivedChunks: 0 },
      data: { receivedChunks: { increment: 1 } },
    });
    expect(prisma.recordingIntake.update).toHaveBeenCalledWith({
      where: { id: INTAKE_ID },
      data: { receivedBytes: { increment: BigInt(5) } },
    });

    prisma.recordingIntake.findUnique.mockResolvedValue(
      baseRow({ receivedBytes: BigInt(5), receivedChunks: 1 })
    );
    const wrongIndex = await putChunk(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/chunks/0`, {
        method: "PUT",
        body: "again",
      }),
      { params: Promise.resolve({ intakeId: INTAKE_ID, index: "0" }) }
    );
    expect(wrongIndex.status).toBe(409);
    expect(await wrongIndex.json()).toMatchObject({ expectedIndex: 1 });

    const tooBig = await putChunk(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/chunks/1`, {
        method: "PUT",
        body: "this exceeds the remaining five bytes",
      }),
      { params: Promise.resolve({ intakeId: INTAKE_ID, index: "1" }) }
    );
    expect(tooBig.status).toBe(413);
    expect(await fs.readFile(filePath, "utf8")).toBe("hello");
  });

  it("rejects a concurrent chunk before touching the file when the slot claim fails", async () => {
    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "source.mp3");
    await fs.writeFile(filePath, "hello");
    prisma.recordingIntake.findUnique.mockResolvedValue(
      baseRow({ receivedBytes: BigInt(5), receivedChunks: 1 })
    );
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 0 });

    const response = await putChunk(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/chunks/1`, {
        method: "PUT",
        body: "world",
      }),
      { params: Promise.resolve({ intakeId: INTAKE_ID, index: "1" }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ expectedIndex: 2 });
    expect(await fs.readFile(filePath, "utf8")).toBe("hello");
    expect(prisma.recordingIntake.update).not.toHaveBeenCalled();
  });

  it("finalizes a complete upload by submitting the ingest job", async () => {
    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "source.mp3"), "0123456789");

    const complete = baseRow({ receivedBytes: BigInt(10), receivedChunks: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue(complete);
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
    prisma.recordingIntake.findUniqueOrThrow.mockResolvedValue({
      ...complete,
      status: "QUEUED",
      jobId: JOB_ID,
    });
    fetchJobsApi.mockResolvedValue({
      id: JOB_ID,
      kind: "INGEST",
      status: "QUEUED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: { intakeId: INTAKE_ID, originalFilename: "talk.mp3" },
    });

    const response = await finalizeUpload(
      jsonRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/finalize`, {}),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      intake: { id: INTAKE_ID, status: "QUEUED", jobId: JOB_ID, sizeBytes: 10 },
    });
    expect(fetchJobsApi).toHaveBeenCalledWith(`/catalogs/${CATALOG_ID}/ingest/jobs`, {
      method: "POST",
      body: { intakeId: INTAKE_ID, originalFilename: "talk.mp3", requestedById: "admin-1" },
      schema: expect.anything(),
    });
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith({
      where: { id: INTAKE_ID, status: "UPLOADING" },
      data: { status: "QUEUED", jobId: JOB_ID },
    });
    expect(logContentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "RECORDING_INGEST_REQUESTED", resourceId: INTAKE_ID })
    );
  });

  it("refuses to finalize an incomplete upload", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(baseRow({ receivedBytes: BigInt(4) }));

    const response = await finalizeUpload(
      jsonRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/finalize`, {}),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(400);
    expect(fetchJobsApi).not.toHaveBeenCalled();
  });

  it("marks the intake FAILED and removes the file when the jobs API rejects the submit", async () => {
    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "source.mp3"), "0123456789");
    const complete = baseRow({ receivedBytes: BigInt(10), receivedChunks: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue(complete);
    prisma.recordingIntake.update.mockResolvedValue({
      ...complete,
      status: "FAILED",
      errorCode: "submit_failed",
    });
    const { JobsApiError } = await import("@/lib/jobs-api/server");
    fetchJobsApi.mockRejectedValue(new JobsApiError("bad request", 400, null));

    const response = await finalizeUpload(
      jsonRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/finalize`, {}),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );

    expect(response.status).toBe(502);
    expect(prisma.recordingIntake.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", errorCode: "submit_failed" }),
      })
    );
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("keeps the upload for retry when the jobs API is unreachable or misconfigured", async () => {
    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "source.mp3"), "0123456789");
    const complete = baseRow({ receivedBytes: BigInt(10), receivedChunks: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue(complete);
    const { JobsApiError, JobsApiConfigurationError } = await import("@/lib/jobs-api/server");

    for (const error of [
      new JobsApiError("jobs api down", 503, null),
      new JobsApiConfigurationError("JOBS_API_BASE_URL is not configured"),
    ]) {
      fetchJobsApi.mockRejectedValueOnce(error);
      const response = await finalizeUpload(
        jsonRequest(`/api/admin/ingest/uploads/${INTAKE_ID}/finalize`, {}),
        { params: Promise.resolve({ intakeId: INTAKE_ID }) }
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ retryable: true });
    }

    expect(prisma.recordingIntake.update).not.toHaveBeenCalled();
    expect(prisma.recordingIntake.updateMany).not.toHaveBeenCalled();
    expect((await fs.stat(path.join(dir, "source.mp3"))).size).toBe(10);
  });

  it("lists intakes and reconciles terminal Prefect states", async () => {
    const running = baseRow({ status: "RUNNING", jobId: JOB_ID, receivedBytes: BigInt(10) });
    prisma.recordingIntake.findMany.mockResolvedValue([running]);
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue({
      ...running,
      status: "FAILED",
      errorCode: "worker_failed",
      errorMessage: "Crashed",
    });
    fetchJobsApi.mockResolvedValue({
      id: JOB_ID,
      kind: "INGEST",
      status: "FAILED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: {},
      error_message: "Crashed",
      prefectStateName: "Crashed",
    });

    const response = await listIntakes(
      new NextRequest(`http://localhost/api/admin/ingest?catalogId=${CATALOG_ID}&limit=5`)
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.intakes).toHaveLength(1);
    expect(payload.intakes[0]).toMatchObject({
      status: "FAILED",
      errorCode: "worker_failed",
      catalogLabel: "Main",
      prefectStateName: "Crashed",
    });
    expect(prisma.recordingIntake.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workflowGroupId: CATALOG_ID }, take: 5 })
    );
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTAKE_ID, status: "RUNNING" },
        data: expect.objectContaining({ status: "FAILED", errorCode: "worker_failed" }),
      })
    );
  });

  it("recovers an outcome the worker could not deliver and syncs on success", async () => {
    const running = baseRow({ status: "RUNNING", jobId: JOB_ID, receivedBytes: BigInt(10) });
    prisma.recordingIntake.findMany.mockResolvedValue([running]);
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue({
      ...running,
      status: "SUCCEEDED",
      audioHash: "b".repeat(64),
    });
    const outcome = JSON.stringify({
      status: "SUCCEEDED",
      audioHash: "B".repeat(64),
      errorCode: null,
      errorMessage: null,
    });
    fetchJobsApi.mockResolvedValue({
      id: JOB_ID,
      kind: "INGEST",
      status: "FAILED",
      requested_by_id: "admin-1",
      catalog_id: CATALOG_ID,
      payload: {},
      error_message: `Flow run encountered an exception: Completion report failed: web down. completion_report_failed:${outcome}`,
      prefectStateName: "Failed",
    });

    const response = await listIntakes(new NextRequest("http://localhost/api/admin/ingest"));

    expect(response.status).toBe(200);
    expect(prisma.recordingIntake.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTAKE_ID, status: "RUNNING" },
        data: expect.objectContaining({ status: "SUCCEEDED", audioHash: "b".repeat(64) }),
      })
    );
    expect(syncCatalogGroup).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("flags a completed run whose callback never arrived and re-syncs", async () => {
    const queued = baseRow({ status: "QUEUED", jobId: JOB_ID, receivedBytes: BigInt(10) });
    prisma.recordingIntake.findMany.mockResolvedValue([queued]);
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
    prisma.recordingIntake.findUnique.mockResolvedValue({
      ...queued,
      status: "SUCCEEDED",
      errorCode: "completion_missing",
    });
    fetchJobsApi.mockResolvedValue({
      id: JOB_ID,
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
        where: { id: INTAKE_ID, status: "QUEUED" },
        data: expect.objectContaining({ status: "SUCCEEDED", errorCode: "completion_missing" }),
      })
    );
    expect(syncCatalogGroup).toHaveBeenCalledWith(CATALOG_ID);
  });

  it("parses undelivered outcomes only when the marker and JSON are present", () => {
    expect(parseUndeliveredOutcome(null)).toBeNull();
    expect(parseUndeliveredOutcome("plain failure")).toBeNull();
    expect(parseUndeliveredOutcome("completion_report_failed:not json")).toBeNull();
    expect(
      parseUndeliveredOutcome(
        'x completion_report_failed:{"status":"REJECTED","audioHash":"A","errorCode":"duplicate"}'
      )
    ).toEqual({ status: "REJECTED", audioHash: "a", errorCode: "duplicate", errorMessage: null });
    expect(parseUndeliveredOutcome('completion_report_failed:{"status":"WHAT"}')).toBeNull();
  });

  it("aborts only uploads that were not submitted", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(baseRow({ status: "QUEUED" }));
    const queued = await abortUpload(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}`, { method: "DELETE" }),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );
    expect(queued.status).toBe(409);
    expect(prisma.recordingIntake.delete).not.toHaveBeenCalled();

    const dir = path.join(mocks.uploadsDir, CATALOG_ID, "incoming", INTAKE_ID);
    await fs.mkdir(dir, { recursive: true });
    prisma.recordingIntake.findUnique.mockResolvedValue(baseRow());
    const uploading = await abortUpload(
      mutationRequest(`/api/admin/ingest/uploads/${INTAKE_ID}`, { method: "DELETE" }),
      { params: Promise.resolve({ intakeId: INTAKE_ID }) }
    );
    expect(uploading.status).toBe(204);
    expect(prisma.recordingIntake.delete).toHaveBeenCalledWith({ where: { id: INTAKE_ID } });
    await expect(fs.stat(dir)).rejects.toThrow();
  });
});
