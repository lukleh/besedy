import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PUT } from "@/app/api/catalogs/[id]/recordings/[hash]/correction/presence/route";
import { clearPresence, loadPresence, recordPresence } from "@/lib/correction/presence";

vi.mock("@/lib/correction/access", () => ({
  requireCorrectionAccess: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

vi.mock("@/lib/correction/workspace-service", () => ({
  requireActiveWorkspace: vi.fn().mockResolvedValue({ id: "ws-1" }),
}));

vi.mock("@/lib/correction/presence", () => ({
  recordPresence: vi.fn(),
  clearPresence: vi.fn(),
  loadPresence: vi.fn(),
}));

const CATALOG_ID = "20261104_120000";
const HASH = "a".repeat(64);
const SPAN_ID = "3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b";
const URL = `http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/correction/presence`;
const params = { params: Promise.resolve({ id: CATALOG_ID, hash: HASH }) };
const jana = { userId: "user-2", name: "Jana", spanId: SPAN_ID, ordinal: 4, startSeconds: 40, editing: true };

function put(body: unknown) {
  return PUT(
    new NextRequest(URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params
  );
}

beforeEach(() => {
  vi.mocked(recordPresence).mockReset();
  vi.mocked(clearPresence).mockReset();
  vi.mocked(loadPresence).mockReset().mockResolvedValue(new Map([["ws-1", [jana]]]));
});

describe("correction presence", () => {
  it("records where the person is and answers with where the others are", async () => {
    const response = await put({ spanId: SPAN_ID, editing: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: "ws-1", people: [jana] });
    expect(recordPresence).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      spanId: SPAN_ID,
      editing: true,
    });
    // The asking person is left out of their own answer.
    expect(loadPresence).toHaveBeenCalledWith(["ws-1"], "user-1");
  });

  it("answers with nobody when the person is alone", async () => {
    vi.mocked(loadPresence).mockResolvedValue(new Map());
    const response = await put({ spanId: null, editing: false });

    expect(await response.json()).toEqual({ workspaceId: "ws-1", people: [] });
  });

  it("refuses a heartbeat that is not a span and a flag", async () => {
    expect((await put({ spanId: "not-a-span", editing: false })).status).toBe(400);
    expect((await put({ spanId: SPAN_ID })).status).toBe(400);
    expect((await put({ spanId: SPAN_ID, editing: false, userId: "user-2" })).status).toBe(400);
    expect(recordPresence).not.toHaveBeenCalled();
  });

  it("takes the person out when they leave the page", async () => {
    const response = await DELETE(new NextRequest(URL, { method: "DELETE" }), params);

    expect(response.status).toBe(204);
    expect(clearPresence).toHaveBeenCalledWith("ws-1", "user-1");
  });
});
