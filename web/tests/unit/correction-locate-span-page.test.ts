import { beforeEach, describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  transcriptSpan: { findFirst: vi.fn(), count: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ default: prisma }));

import { locateSpanPage } from "@/lib/correction/workspace-service";

beforeEach(() => {
  prisma.transcriptSpan.findFirst.mockReset();
  prisma.transcriptSpan.count.mockReset();
});

describe("locateSpanPage", () => {
  it("finds the page by the span's position among the workspace's spans", async () => {
    prisma.transcriptSpan.findFirst.mockResolvedValue({ ordinal: 731 });
    // Fewer spans come before it than its ordinal says: the page follows the
    // list's order, not the raw ordinal.
    prisma.transcriptSpan.count.mockResolvedValue(399);

    await expect(locateSpanPage("ws-1", "span-1", 200)).resolves.toBe(200);
    expect(prisma.transcriptSpan.findFirst).toHaveBeenCalledWith({
      where: { id: "span-1", workspaceId: "ws-1" },
      select: { ordinal: true },
    });
    expect(prisma.transcriptSpan.count).toHaveBeenCalledWith({
      where: { workspaceId: "ws-1", ordinal: { lt: 731 } },
    });
  });

  it("starts the page on the span when it opens a page", async () => {
    prisma.transcriptSpan.findFirst.mockResolvedValue({ ordinal: 400 });
    prisma.transcriptSpan.count.mockResolvedValue(400);
    await expect(locateSpanPage("ws-1", "span-1", 200)).resolves.toBe(400);
  });

  it("is null for a span outside the workspace", async () => {
    prisma.transcriptSpan.findFirst.mockResolvedValue(null);
    await expect(locateSpanPage("ws-1", "elsewhere", 200)).resolves.toBeNull();
    expect(prisma.transcriptSpan.count).not.toHaveBeenCalled();
  });
});
