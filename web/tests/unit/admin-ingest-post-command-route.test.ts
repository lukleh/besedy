import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PUT } from "@/app/api/admin/ingest/post-command/route";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getAdminCapability: vi.fn(),
  logCatalogLifecycleEvent: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/auth/permissions", () => ({
  requireAuth: mocks.requireAuth,
  AuthError: class AuthError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 403) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));
vi.mock("@/lib/access/capabilities", () => ({ getAdminCapability: mocks.getAdminCapability }));
vi.mock("@/lib/archive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/archive")>()),
  requireArchive: vi.fn(async () => ({ id: CATALOG_ID, label: "Main" })),
}));
vi.mock("@/lib/audit/logger", () => ({ logCatalogLifecycleEvent: mocks.logCatalogLifecycleEvent }));
vi.mock("@/lib/db", () => ({
  default: { workflowGroup: { findUnique: mocks.findUnique, update: mocks.update } },
}));

const CATALOG_ID = "20260201_120000";
const COMMAND = "/home/u/event-artwork-hook.sh {event_id} /home/u/docs/prompt.md";

function put(body: unknown, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/admin/ingest/post-command", {
    method: "PUT",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("admin post-ingest command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("admin-1");
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: true });
    mocks.findUnique.mockResolvedValue({ ingestPostCommand: null });
    mocks.logCatalogLifecycleEvent.mockResolvedValue(undefined);
  });

  it("is admin only for reading and writing", async () => {
    mocks.getAdminCapability.mockResolvedValue({ canAccessAdmin: false });

    const [read, write] = await Promise.all([GET(), PUT(put({ command: COMMAND }))]);

    expect([read.status, write.status]).toEqual([403, 403]);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a cross-site write", async () => {
    const response = await PUT(put({ command: COMMAND }, "https://evil.example"));

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns the saved command", async () => {
    mocks.findUnique.mockResolvedValue({ ingestPostCommand: COMMAND });

    const response = await GET();

    expect(await response.json()).toEqual({ command: COMMAND });
  });

  it("saves a command and audits the previous and the new value", async () => {
    mocks.findUnique.mockResolvedValue({ ingestPostCommand: "/old {intake_id}" });

    const response = await PUT(put({ command: `  ${COMMAND}  ` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ command: COMMAND });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: CATALOG_ID },
      data: { ingestPostCommand: COMMAND },
    });
    expect(mocks.logCatalogLifecycleEvent).toHaveBeenCalledWith({
      action: "CATALOG_UPDATED",
      actorId: "admin-1",
      catalogId: CATALOG_ID,
      catalogLabel: "Main",
      details: { field: "ingestPostCommand", previous: "/old {intake_id}", next: COMMAND },
    });
  });

  it("clears the command with an empty value", async () => {
    mocks.findUnique.mockResolvedValue({ ingestPostCommand: COMMAND });

    const response = await PUT(put({ command: " " }));

    expect(await response.json()).toEqual({ command: null });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: CATALOG_ID },
      data: { ingestPostCommand: null },
    });
  });

  it("does not write or audit an unchanged command", async () => {
    mocks.findUnique.mockResolvedValue({ ingestPostCommand: COMMAND });

    await PUT(put({ command: COMMAND }));

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.logCatalogLifecycleEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["/bin/true {evnt_id}"],
    ["/bin/true\n/bin/false"],
    ["x".repeat(2001)],
  ])("rejects an invalid command: %s", async (command) => {
    const response = await PUT(put({ command }));

    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
