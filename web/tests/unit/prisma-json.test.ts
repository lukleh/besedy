import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { toPrismaJson } from "@/lib/prisma-json";

describe("toPrismaJson", () => {
  it("maps absent values to database null", () => {
    expect(toPrismaJson(null)).toBe(Prisma.DbNull);
    expect(toPrismaJson(undefined)).toBe(Prisma.DbNull);
  });

  it("preserves explicit JSON null sentinels", () => {
    expect(toPrismaJson(Prisma.JsonNull)).toBe(Prisma.JsonNull);
  });

  it("passes through regular JSON payloads", () => {
    const payload = { nested: ["value"], enabled: true };
    expect(toPrismaJson(payload)).toBe(payload);
  });
});
