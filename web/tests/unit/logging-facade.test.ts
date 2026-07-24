import { describe, expect, it, vi } from "vitest";
import { createClientLogger } from "@/lib/log/client";
import { createServerLogger } from "@/lib/log/server";

describe("logging facade", () => {
  it("prefixes client logs and preserves payload arguments", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const logger = createClientLogger("SW");
      logger.info("Update available", { version: "abc123" });

      expect(logSpy).toHaveBeenCalledWith("[SW] Update available", {
        version: "abc123",
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("writes structured server events as JSON", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const logger = createServerLogger();
      logger.event("info", { event: "auth_request_decision", reason: "authenticated" });

      expect(infoSpy).toHaveBeenCalledWith(
        JSON.stringify({
          event: "auth_request_decision",
          reason: "authenticated",
        })
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});
