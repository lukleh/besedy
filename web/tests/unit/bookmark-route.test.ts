import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PATCH } from "@/app/api/bookmarks/[id]/route";
import { AuthError } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  deleteMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  default: {
    recordingBookmark: {
      update: mocks.update,
      deleteMany: mocks.deleteMany,
    },
  },
}));

vi.mock("@/lib/auth/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/permissions")>()),
  requireAuth: mocks.requireAuth,
}));

const ID = "cmbookmark0000000000000001";
const URL = `http://localhost/api/bookmarks/${ID}`;
const params = Promise.resolve({ id: ID });
const DATE = new Date("2026-10-03T12:00:00Z");

function request(method: string, body?: unknown) {
  return new NextRequest(URL, {
    method,
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("bookmark route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue("user-1");
  });

  it("changes the comment of the user's own bookmark", async () => {
    mocks.update.mockResolvedValue({
      id: ID,
      positionSec: 30,
      comment: "Second thought",
      excerpt: null,
      createdAt: DATE,
      updatedAt: DATE,
    });

    const response = await PATCH(request("PATCH", { comment: " Second thought " }), { params });

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: ID, userId: "user-1" },
      data: { comment: "Second thought" },
      select: expect.any(Object),
    });
    expect(await response.json()).toMatchObject({ bookmark: { id: ID, comment: "Second thought" } });
  });

  it("answers another user's bookmark as missing", async () => {
    // What Prisma throws when the owner-scoped where matches no row.
    mocks.update.mockRejectedValue(Object.assign(new Error("Record not found"), { code: "P2025" }));
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    expect((await PATCH(request("PATCH", { comment: "x" }), { params })).status).toBe(404);
    expect((await DELETE(request("DELETE"), { params })).status).toBe(404);
  });

  it("deletes the user's own bookmark", async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(request("DELETE"), { params });

    expect(response.status).toBe(204);
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { id: ID, userId: "user-1" } });
  });

  it("requires a signed-in user", async () => {
    mocks.requireAuth.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await DELETE(request("DELETE"), { params });

    expect(response.status).toBe(401);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed id before touching the database", async () => {
    const response = await DELETE(request("DELETE"), {
      params: Promise.resolve({ id: "../other" }),
    });

    expect(response.status).toBe(400);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
