import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as reportProgress } from "@/app/api/internal/ingest/[intakeId]/progress/route";

vi.mock("@/lib/db", () => ({
  default: {
    recordingIntake: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const INTAKE_ID = "cmf9abcdefghijklmnopqrstu";
const originalEnv = process.env;

function request(body: unknown, token: string | null = "job-secret") {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new NextRequest(`http://localhost/api/internal/ingest/${INTAKE_ID}/progress`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function call(body: unknown, token?: string | null) {
  return reportProgress(request(body, token), {
    params: Promise.resolve({ intakeId: INTAKE_ID }),
  });
}

describe("internal ingest progress route", () => {
  let prisma: {
    recordingIntake: {
      findUnique: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, BESEDY_JOB_SERVICE_SECRET: "job-secret" };
    prisma = (await import("@/lib/db")).default as unknown as typeof prisma;
    prisma.recordingIntake.findUnique.mockResolvedValue({ startedAt: null });
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("refuses a request without the job service secret", async () => {
    const response = await call({ label: "catalog add" }, "wrong-secret");

    expect(response.status).toBe(401);
    expect(prisma.recordingIntake.updateMany).not.toHaveBeenCalled();
  });

  it("records the step on an active intake and starts the run clock once", async () => {
    const response = await call({ step: 4, total: 9, label: "transcribe (canary-nemo@lang-cs)" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: true });
    const args = prisma.recordingIntake.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({
      id: INTAKE_ID,
      status: { in: ["QUEUED", "RUNNING", "REMOVING"] },
    });
    expect(args.data).toMatchObject({
      progressStep: 4,
      progressTotal: 9,
      progressLabel: "transcribe (canary-nemo@lang-cs)",
    });
    expect(args.data.progressStepStartedAt).toBeInstanceOf(Date);
    expect(args.data.startedAt).toBe(args.data.progressStepStartedAt);
    // Progress is display only: the status is never written.
    expect(args.data).not.toHaveProperty("status");
  });

  it("keeps the run start of an earlier report", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue({
      startedAt: new Date("2026-10-04T10:55:00Z"),
    });

    await call({ label: "catalog add" });

    const args = prisma.recordingIntake.updateMany.mock.calls[0][0];
    expect(args.data).not.toHaveProperty("startedAt");
    expect(args.data).toMatchObject({ progressStep: null, progressTotal: null });
  });

  it("acknowledges but ignores reports for an intake that is no longer active", async () => {
    prisma.recordingIntake.updateMany.mockResolvedValue({ count: 0 });

    const response = await call({ step: 9, total: 9, label: "cluster-speakers" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, applied: false });
  });

  it("caps long labels", async () => {
    await call({ label: "x".repeat(500) });

    const args = prisma.recordingIntake.updateMany.mock.calls[0][0];
    expect(args.data.progressLabel).toHaveLength(200);
  });

  it("returns 404 for an unknown intake", async () => {
    prisma.recordingIntake.findUnique.mockResolvedValue(null);

    const response = await call({ label: "catalog add" });

    expect(response.status).toBe(404);
    expect(prisma.recordingIntake.updateMany).not.toHaveBeenCalled();
  });
});
