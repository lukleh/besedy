import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "@/lib/security/constant-time";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("Bearer secret-token", "Bearer secret-token")).toBe(true);
  });

  it("returns false when content differs at the same length", () => {
    expect(constantTimeEqual("Bearer secret-tokeX", "Bearer secret-token")).toBe(false);
    // Difference in the first character must still be caught.
    expect(constantTimeEqual("Xearer secret-token", "Bearer secret-token")).toBe(false);
  });

  it("returns false on length mismatch", () => {
    expect(constantTimeEqual("Bearer secret", "Bearer secret-token")).toBe(false);
    expect(constantTimeEqual("Bearer secret-token-extra", "Bearer secret-token")).toBe(false);
  });

  it("handles empty inputs", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("x", "")).toBe(false);
    expect(constantTimeEqual("", "secret")).toBe(false);
  });
});
