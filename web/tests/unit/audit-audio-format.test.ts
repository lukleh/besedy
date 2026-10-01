import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({ default: { auditLog: { create: mockCreate } } }));

import { logAudioDownloaded, logAudioStreamed } from "@/lib/audit/logger";

const HASH = "a".repeat(64);

function payload(): Record<string, unknown> {
  return mockCreate.mock.calls[0][0].data.details;
}

describe("audio audit format", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({});
  });

  it("records the AAC copy on streams, with or without a range", async () => {
    await logAudioStreamed("user-1", HASH, "cat", { start: 0, end: 9, fileSize: 10 }, "aac");
    expect(payload()).toMatchObject({ rangeStart: 0, rangeEnd: 9, fileSize: 10, format: "aac" });

    mockCreate.mockClear();
    await logAudioStreamed("user-1", HASH, "cat", null, "aac");
    expect(payload()).toMatchObject({ format: "aac" });
  });

  it("records the AAC copy on downloads next to the source", async () => {
    await logAudioDownloaded("user-1", HASH, "cat", "archived", "aac");
    expect(payload()).toMatchObject({ source: "archived", format: "aac" });
  });

  it("keeps the WebM records unchanged", async () => {
    await logAudioStreamed("user-1", HASH, "cat", { start: 0, end: 9, fileSize: 10 });
    expect(payload()).not.toHaveProperty("format");

    mockCreate.mockClear();
    await logAudioDownloaded("user-1", HASH, "cat", "archived");
    expect(payload()).toMatchObject({ source: "archived" });
    expect(payload()).not.toHaveProperty("format");
  });
});
