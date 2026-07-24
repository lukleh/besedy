import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";

vi.mock("@/lib/config", () => ({
  getTextDataDir: () => {
    throw new Error("config not available");
  },
  getPostersDir: () => {
    throw new Error("config not available");
  },
  getSourcesDir: () => {
    throw new Error("config not available");
  },
}));

describe("path-validation", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe("getAllowedBaseDirs", () => {
    it("returns empty array when no base dir configured", async () => {
      delete process.env.BESEDY_BASE_DIR;
      delete process.env.BESEDY_ALLOWED_PATHS;

      const { getAllowedBaseDirs } = await import("@/lib/security/path-validation");
      const dirs = getAllowedBaseDirs();
      expect(dirs).toEqual([]);
    });

    it("includes BESEDY_BASE_DIR when set", async () => {
      process.env.BESEDY_BASE_DIR = "/test/base/dir";
      delete process.env.BESEDY_ALLOWED_PATHS;

      const { getAllowedBaseDirs } = await import("@/lib/security/path-validation");
      const dirs = getAllowedBaseDirs();

      // Should contain exactly one path - the resolved base dir
      expect(dirs).toHaveLength(1);
      // Path should be resolved (absolute) and contain the base dir components
      expect(dirs[0]).toMatch(/\/test\/base\/dir$/);
    });

    it("includes BESEDY_ALLOWED_PATHS when set", async () => {
      process.env.BESEDY_BASE_DIR = "/base";
      process.env.BESEDY_ALLOWED_PATHS = "/path1, /path2";

      const { getAllowedBaseDirs } = await import("@/lib/security/path-validation");
      const dirs = getAllowedBaseDirs();

      // Should contain all 3 paths: base dir + 2 allowed paths
      expect(dirs).toHaveLength(3);
      // Verify each path is present (resolved)
      expect(dirs.some(d => d.endsWith("/base"))).toBe(true);
      expect(dirs.some(d => d.endsWith("/path1"))).toBe(true);
      expect(dirs.some(d => d.endsWith("/path2"))).toBe(true);
    });
  });

  describe("validatePath", () => {
    it("rejects when no allowed directories configured", async () => {
      delete process.env.BESEDY_BASE_DIR;
      delete process.env.BESEDY_ALLOWED_PATHS;

      const { validatePath } = await import("@/lib/security/path-validation");
      // Non-existent path will fail before checking allowed dirs
      const result = validatePath("/some/path/file.txt");

      expect(result.valid).toBe(false);
      // Should have a specific rejection reason
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
      // Reason should explain why it failed (either no config or path doesn't exist)
      expect(result.reason).toMatch(/not set|not exist|not accessible|not configured/i);
    });

    it("rejects non-existent paths", async () => {
      process.env.BESEDY_BASE_DIR = "/tmp";

      const { validatePath } = await import("@/lib/security/path-validation");
      const result = validatePath("/tmp/definitely-does-not-exist-abc123.txt");

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("Path does not exist or is not accessible");
    });

    it("validates existing paths within allowed directories", async () => {
      // Use /tmp which exists on most systems
      process.env.BESEDY_BASE_DIR = "/tmp";

      const { validatePath } = await import("@/lib/security/path-validation");
      // Validate /tmp itself which should exist
      const result = validatePath("/tmp");

      expect(result.valid).toBe(true);
    });
  });

  describe("requireValidPath", () => {
    it("throws PathValidationError for paths outside allowed directories", async () => {
      delete process.env.BESEDY_BASE_DIR;

      const { requireValidPath, PathValidationError } = await import("@/lib/security/path-validation");

      expect(() => requireValidPath("/some/path")).toThrow(PathValidationError);
    });
  });
});
