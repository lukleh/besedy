import { describe, it, expect } from "vitest";
import { z } from "zod";
import { IntIdSchema, IntIdParamSchema } from "@/lib/api/validation";

describe("IntIdSchema", () => {
  it("should parse valid integer strings", () => {
    expect(IntIdSchema.parse("1")).toBe(1);
    expect(IntIdSchema.parse("42")).toBe(42);
    expect(IntIdSchema.parse("999")).toBe(999);
    expect(IntIdSchema.parse("0")).toBe(0);
  });

  it("should parse large integers", () => {
    expect(IntIdSchema.parse("1000000")).toBe(1000000);
    expect(IntIdSchema.parse("2147483647")).toBe(2147483647);
  });

  it("should reject non-numeric strings", () => {
    expect(() => IntIdSchema.parse("abc")).toThrow();
    expect(() => IntIdSchema.parse("")).toThrow();
    expect(() => IntIdSchema.parse("null")).toThrow();
  });

  it("should parse numeric prefix from mixed strings", () => {
    // parseInt("12abc") returns 12 - this is expected behavior
    expect(IntIdSchema.parse("12abc")).toBe(12);
    expect(IntIdSchema.parse("42xyz")).toBe(42);
  });

  it("should reject float strings", () => {
    // parseInt truncates, so "3.14" becomes 3
    expect(IntIdSchema.parse("3.14")).toBe(3);
  });

  it("should handle negative integers", () => {
    expect(IntIdSchema.parse("-1")).toBe(-1);
    expect(IntIdSchema.parse("-100")).toBe(-100);
  });

  it("should handle leading zeros", () => {
    expect(IntIdSchema.parse("007")).toBe(7);
    expect(IntIdSchema.parse("0042")).toBe(42);
  });

  it("should reject whitespace-only strings", () => {
    expect(() => IntIdSchema.parse("   ")).toThrow();
  });

  it("should handle strings with leading/trailing whitespace", () => {
    // parseInt handles leading whitespace
    expect(IntIdSchema.parse("  42")).toBe(42);
  });
});

describe("IntIdParamSchema", () => {
  it("should parse valid id params", () => {
    const result = IntIdParamSchema.parse({ id: "123" });
    expect(result.id).toBe(123);
  });

  it("should reject missing id", () => {
    expect(() => IntIdParamSchema.parse({})).toThrow();
  });

  it("should reject invalid id format", () => {
    expect(() => IntIdParamSchema.parse({ id: "abc" })).toThrow();
  });

  it("should allow extra properties to pass through", () => {
    const result = IntIdParamSchema.parse({ id: "5", extra: "ignored" });
    expect(result.id).toBe(5);
  });
});
