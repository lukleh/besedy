import { describe, it, expect, beforeEach } from "vitest";
import {
  checkRateLimit,
  getRateLimitRemaining,
  getRateLimitResetMs,
  clearRateLimit,
  clearAllRateLimits,
} from "@/lib/security/rate-limit";

describe("rate-limit", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  describe("checkRateLimit", () => {
    it("allows first request", () => {
      expect(checkRateLimit("test:ip1", 5, 60000)).toBe(true);
    });

    it("allows requests up to limit", () => {
      const key = "test:ip2";
      expect(checkRateLimit(key, 3, 60000)).toBe(true);
      expect(checkRateLimit(key, 3, 60000)).toBe(true);
      expect(checkRateLimit(key, 3, 60000)).toBe(true);
    });

    it("blocks requests after limit exceeded", () => {
      const key = "test:ip3";
      expect(checkRateLimit(key, 2, 60000)).toBe(true);
      expect(checkRateLimit(key, 2, 60000)).toBe(true);
      expect(checkRateLimit(key, 2, 60000)).toBe(false);
      expect(checkRateLimit(key, 2, 60000)).toBe(false);
    });

    it("tracks different keys independently", () => {
      expect(checkRateLimit("user:a", 1, 60000)).toBe(true);
      expect(checkRateLimit("user:b", 1, 60000)).toBe(true);
      expect(checkRateLimit("user:a", 1, 60000)).toBe(false);
      expect(checkRateLimit("user:b", 1, 60000)).toBe(false);
    });

    it("resets after window expires", async () => {
      const key = "test:expiry";
      const windowMs = 50; // 50ms window

      expect(checkRateLimit(key, 1, windowMs)).toBe(true);
      expect(checkRateLimit(key, 1, windowMs)).toBe(false);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Should be allowed again
      expect(checkRateLimit(key, 1, windowMs)).toBe(true);
    });
  });

  describe("getRateLimitRemaining", () => {
    it("returns full limit for new key", () => {
      expect(getRateLimitRemaining("new:key", 10)).toBe(10);
    });

    it("returns remaining count after requests", () => {
      const key = "test:remaining";
      checkRateLimit(key, 5, 60000);
      expect(getRateLimitRemaining(key, 5)).toBe(4);

      checkRateLimit(key, 5, 60000);
      checkRateLimit(key, 5, 60000);
      expect(getRateLimitRemaining(key, 5)).toBe(2);
    });

    it("returns 0 when limit exhausted", () => {
      const key = "test:exhausted";
      for (let i = 0; i < 5; i++) {
        checkRateLimit(key, 5, 60000);
      }
      expect(getRateLimitRemaining(key, 5)).toBe(0);
    });

    it("returns full limit after window expires", async () => {
      const key = "test:expired";
      checkRateLimit(key, 5, 50);
      checkRateLimit(key, 5, 50);
      expect(getRateLimitRemaining(key, 5)).toBe(3);

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(getRateLimitRemaining(key, 5)).toBe(5);
    });
  });

  describe("getRateLimitResetMs", () => {
    it("returns 0 for unknown key", () => {
      expect(getRateLimitResetMs("unknown:key")).toBe(0);
    });

    it("returns positive value for active limit", () => {
      checkRateLimit("test:reset", 5, 60000);
      const resetMs = getRateLimitResetMs("test:reset");
      expect(resetMs).toBeGreaterThan(0);
      expect(resetMs).toBeLessThanOrEqual(60000);
    });

    it("returns 0 after window expires", async () => {
      checkRateLimit("test:expired-reset", 5, 50);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(getRateLimitResetMs("test:expired-reset")).toBe(0);
    });
  });

  describe("clearRateLimit", () => {
    it("clears specific key", () => {
      const key = "test:clear";
      checkRateLimit(key, 1, 60000);
      expect(checkRateLimit(key, 1, 60000)).toBe(false);

      clearRateLimit(key);
      expect(checkRateLimit(key, 1, 60000)).toBe(true);
    });

    it("does not affect other keys", () => {
      checkRateLimit("key:a", 1, 60000);
      checkRateLimit("key:b", 1, 60000);

      clearRateLimit("key:a");

      expect(checkRateLimit("key:a", 1, 60000)).toBe(true);
      expect(checkRateLimit("key:b", 1, 60000)).toBe(false);
    });
  });

  describe("clearAllRateLimits", () => {
    it("clears all keys", () => {
      checkRateLimit("key:1", 1, 60000);
      checkRateLimit("key:2", 1, 60000);
      checkRateLimit("key:3", 1, 60000);

      clearAllRateLimits();

      expect(checkRateLimit("key:1", 1, 60000)).toBe(true);
      expect(checkRateLimit("key:2", 1, 60000)).toBe(true);
      expect(checkRateLimit("key:3", 1, 60000)).toBe(true);
    });
  });

  describe("security scenarios", () => {
    it("blocks brute force login attempts", () => {
      const ip = "192.168.1.100";
      const key = `auth:${ip}`;
      const maxAttempts = 5;
      const windowMs = 15 * 60 * 1000; // 15 minutes

      // Simulate 5 failed login attempts
      for (let i = 0; i < maxAttempts; i++) {
        expect(checkRateLimit(key, maxAttempts, windowMs)).toBe(true);
      }

      // 6th attempt should be blocked
      expect(checkRateLimit(key, maxAttempts, windowMs)).toBe(false);
    });

    it("handles multiple IPs independently", () => {
      const ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];

      // Each IP can make their own requests
      for (const ip of ips) {
        expect(checkRateLimit(`api:${ip}`, 2, 60000)).toBe(true);
        expect(checkRateLimit(`api:${ip}`, 2, 60000)).toBe(true);
        expect(checkRateLimit(`api:${ip}`, 2, 60000)).toBe(false);
      }
    });
  });
});
