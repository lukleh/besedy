import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DELETE, PUT } from "@/app/api/catalogs/[id]/recordings/[hash]/correction/presence/route";
import { clearPresence, loadPresence, recordPresence } from "@/lib/correction/presence";

vi.mock("@/lib/correction/access", () => ({
  requireCorrectionAccess: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

vi.mock("@/lib/correction/workspace-service", () => ({
  requireActiveWorkspace: vi.fn().mockResolvedValue({ id: "9a1c2e3f-4b5d-4c6e-8f70-112233445566" }),
}));

vi.mock("@/lib/correction/presence", () => ({
  recordPresence: vi.fn(),
  clearPresence: vi.fn(),
  loadPresence: vi.fn(),
}));

const CATALOG_ID = "20261104_120000";
const HASH = "a".repeat(64);
const SPAN_ID = "3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b";
const WORKSPACE_ID = "9a1c2e3f-4b5d-4c6e-8f70-112233445566";
const OLD_WORKSPACE_ID = "0b1c2d3e-4f50-4a6b-8c7d-665544332211";
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
  vi.mocked(loadPresence).mockReset().mockResolvedValue(new Map([[WORKSPACE_ID, [jana]]]));
});

describe("correction presence", () => {
  it("records where the person is and answers with where the others are", async () => {
    const response = await put({ workspaceId: WORKSPACE_ID, spanId: SPAN_ID, editing: true });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspaceId: WORKSPACE_ID, people: [jana] });
    expect(recordPresence).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: "user-1",
      spanId: SPAN_ID,
      editing: true,
    });
    // The asking person is left out of their own answer.
    expect(loadPresence).toHaveBeenCalledWith([WORKSPACE_ID], "user-1");
  });

  it("answers with nobody when the person is alone", async () => {
    vi.mocked(loadPresence).mockResolvedValue(new Map());
    const response = await put({ workspaceId: WORKSPACE_ID, spanId: null, editing: false });

    expect(await response.json()).toEqual({ workspaceId: WORKSPACE_ID, people: [] });
  });

  it("refuses a heartbeat that is not a span and a flag", async () => {
    const valid = { workspaceId: WORKSPACE_ID, spanId: SPAN_ID, editing: false };
    expect((await put({ ...valid, spanId: "not-a-span" })).status).toBe(400);
    expect((await put({ workspaceId: WORKSPACE_ID, spanId: SPAN_ID })).status).toBe(400);
    expect((await put({ spanId: SPAN_ID, editing: false })).status).toBe(400);
    expect((await put({ ...valid, userId: "user-2" })).status).toBe(400);
    expect(recordPresence).not.toHaveBeenCalled();
  });

  // Archived and started again: the old page is not in the new workspace.
  it("refuses a page that shows a workspace which is no longer the active one", async () => {
    const response = await put({ workspaceId: OLD_WORKSPACE_ID, spanId: SPAN_ID, editing: true });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    expect(recordPresence).not.toHaveBeenCalled();
    expect(loadPresence).not.toHaveBeenCalled();
  });

  it("clears nothing when the page that leaves showed an earlier workspace", async () => {
    const response = await DELETE(new NextRequest(`${URL}?workspace=${OLD_WORKSPACE_ID}`, { method: "DELETE" }), params);

    expect(response.status).toBe(204);
    expect(clearPresence).not.toHaveBeenCalled();
    expect((await DELETE(new NextRequest(URL, { method: "DELETE" }), params)).status).toBe(204);
    expect(clearPresence).not.toHaveBeenCalled();
  });

  it("writes nothing for a heartbeat the page has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await PUT(
      new NextRequest(URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: WORKSPACE_ID, spanId: SPAN_ID, editing: true }),
        signal: controller.signal,
      }),
      params
    );

    expect(response.status).toBe(204);
    expect(recordPresence).not.toHaveBeenCalled();
  });

  it("takes the person out when they leave the page", async () => {
    const response = await DELETE(new NextRequest(`${URL}?workspace=${WORKSPACE_ID}`, { method: "DELETE" }), params);

    expect(response.status).toBe(204);
    expect(clearPresence).toHaveBeenCalledWith(WORKSPACE_ID, "user-1");
  });
});
