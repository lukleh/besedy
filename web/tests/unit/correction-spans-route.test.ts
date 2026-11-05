import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/catalogs/[id]/recordings/[hash]/correction/spans/route";
import { listSpans, locateSpanPage } from "@/lib/correction/workspace-service";

vi.mock("@/lib/correction/access", () => ({
  requireCorrectionAccess: vi.fn().mockResolvedValue({ userId: "user-1" }),
}));

vi.mock("@/lib/correction/workspace-service", () => ({
  requireActiveWorkspace: vi.fn().mockResolvedValue({ id: "ws-1" }),
  listSpans: vi.fn(),
  locateSpanPage: vi.fn(),
}));

const CATALOG_ID = "20261104_120000";
const HASH = "a".repeat(64);
const SPAN_ID = "3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b";
const listSpansMock = vi.mocked(listSpans);
const locateSpanPageMock = vi.mocked(locateSpanPage);

function request(query: string) {
  return GET(
    new NextRequest(`http://localhost/api/catalogs/${CATALOG_ID}/recordings/${HASH}/correction/spans?${query}`),
    { params: Promise.resolve({ id: CATALOG_ID, hash: HASH }) }
  );
}

beforeEach(() => {
  listSpansMock.mockReset().mockResolvedValue({ total: 450, spans: [] });
  locateSpanPageMock.mockReset();
});

describe("GET correction spans", () => {
  it("returns the page at the requested offset", async () => {
    const response = await request("offset=200&limit=200");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workspaceId: "ws-1", offset: 200, limit: 200, total: 450 });
    expect(listSpansMock).toHaveBeenCalledWith("ws-1", { offset: 200, limit: 200 });
    expect(locateSpanPageMock).not.toHaveBeenCalled();
  });

  it("returns the page holding a linked segment instead of the one at offset", async () => {
    locateSpanPageMock.mockResolvedValue(400);
    const response = await request(`segment=${SPAN_ID}&offset=0&limit=200`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ offset: 400, limit: 200 });
    expect(locateSpanPageMock).toHaveBeenCalledWith("ws-1", SPAN_ID, 200);
    expect(listSpansMock).toHaveBeenCalledWith("ws-1", { offset: 400, limit: 200 });
  });

  it("reports a segment that is not in this workspace as SPAN_NOT_FOUND", async () => {
    locateSpanPageMock.mockResolvedValue(null);
    const response = await request(`segment=${SPAN_ID}&limit=200`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SPAN_NOT_FOUND" });
    expect(listSpansMock).not.toHaveBeenCalled();
  });

  it("reports a segment that is not a span ID as SPAN_NOT_FOUND without querying", async () => {
    const response = await request("segment=not-a-span&limit=200");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "SPAN_NOT_FOUND" });
    expect(locateSpanPageMock).not.toHaveBeenCalled();
    expect(listSpansMock).not.toHaveBeenCalled();
  });
});
