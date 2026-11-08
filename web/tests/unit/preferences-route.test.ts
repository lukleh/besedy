import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH } from "@/app/api/preferences/route";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), upsert: vi.fn() }));
vi.mock("@/lib/auth/permissions", async (original) => ({ ...await original<typeof import("@/lib/auth/permissions")>(), requireAuth: mocks.auth }));
vi.mock("@/lib/db", () => ({ default: { userPreferences: { upsert: mocks.upsert } } }));

const prefs = { userId: "user-1", theme: "dark", catalogColumns: ["title"], settings: { textSize: "large" } };
function patch(body: unknown) {
  return PATCH(new NextRequest("http://localhost/api/preferences", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

describe("content-independent preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue("user-1");
    mocks.upsert.mockResolvedValue(prefs);
  });

  it("retains appearance and display settings", async () => {
    expect(await (await GET()).json()).toEqual(prefs);
    expect(await (await patch({ theme: "dark", settings: prefs.settings })).json()).toEqual(prefs);
  });

  it("rejects the retired catalog preference without writing it", async () => {
    expect((await patch({ activeGroupId: "another-source" })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("keeps preference reads restricted to display fields", async () => {
    await GET();
    expect(mocks.upsert.mock.calls[0][0].select).toEqual({
      userId: true, theme: true, catalogColumns: true, settings: true,
    });
  });
});
