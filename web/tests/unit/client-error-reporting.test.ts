import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reportClientError } from "@/lib/client-error-reporting";

describe("client-error-reporting", () => {
  const originalWindow = global.window;
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Mock window object
    global.window = {
      location: { href: "http://localhost:3000/test" },
    } as unknown as Window & typeof globalThis;

    // Mock navigator
    global.navigator = {
      userAgent: "test-user-agent",
    } as unknown as Navigator;

    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    global.window = originalWindow;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("error filtering", () => {
    it("ignores ResizeObserver loop errors", () => {
      reportClientError({
        message: "ResizeObserver loop completed with undelivered notifications.",
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("ignores ResizeObserver loop limit exceeded", () => {
      reportClientError({
        message: "ResizeObserver loop limit exceeded",
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("reports real errors", () => {
      reportClientError({
        message: "TypeError: Cannot read property 'foo' of undefined",
        stack: "Error stack trace...",
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("reports errors with partial ResizeObserver text that is not the warning", () => {
      reportClientError({
        message: "Error in ResizeObserver callback handler",
      });

      // This should be reported because it's not the benign warning
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("error reporting", () => {
    it("sends error to API endpoint", () => {
      reportClientError({
        message: "Test error",
        stack: "Error stack",
      });

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/csp-report/client-error",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
        })
      );
    });

    it("includes message and stack in payload", () => {
      reportClientError({
        message: "Test error",
        stack: "Error stack trace",
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.message).toBe("Test error");
      expect(body.stack).toBe("Error stack trace");
    });

    it("includes url from window.location when not provided", () => {
      reportClientError({
        message: "Test error",
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.url).toBe("http://localhost:3000/test");
    });

    it("uses provided url over window.location", () => {
      reportClientError({
        message: "Test error",
        url: "http://example.com/custom",
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.url).toBe("http://example.com/custom");
    });

    it("includes userAgent from navigator when not provided", () => {
      reportClientError({
        message: "Test error",
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.userAgent).toBe("test-user-agent");
    });

    it("includes optional fields when provided", () => {
      reportClientError({
        message: "Test error",
        digest: "abc123",
        source: "error-boundary",
        context: { component: "TestComponent" },
      });

      const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const body = JSON.parse(call[1].body);

      expect(body.digest).toBe("abc123");
      expect(body.source).toBe("error-boundary");
      expect(body.context).toEqual({ component: "TestComponent" });
    });
  });

  describe("server-side behavior", () => {
    it("does nothing when window is undefined (SSR)", () => {
      // Temporarily remove window
      const tempWindow = global.window;
      // @ts-expect-error - intentionally setting to undefined for SSR simulation
      global.window = undefined;

      reportClientError({
        message: "Test error",
      });

      expect(global.fetch).not.toHaveBeenCalled();

      global.window = tempWindow;
    });
  });

  describe("error handling", () => {
    it("silently fails if fetch throws", () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Network error")
      );

      // Should not throw
      expect(() => {
        reportClientError({
          message: "Test error",
        });
      }).not.toThrow();
    });
  });
});
