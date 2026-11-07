import { describe, expect, it, vi } from "vitest";
import { CorrectionError } from "@/lib/correction/errors";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import { ArchiveConfigurationError, ArchiveScopeError } from "@/lib/archive";

vi.mock("@/lib/log/server", () => ({
  createServerLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

describe("handleCorrectionRouteError", () => {
  it("keeps internal archive scope and configuration failures as 404 and 503", () => {
    expect(handleCorrectionRouteError(new ArchiveScopeError(), "fetch").status).toBe(404);
    expect(handleCorrectionRouteError(new ArchiveConfigurationError("Invalid archive configuration"), "update").status).toBe(503);
  });
  it("answers a correction error with its own status and code", async () => {
    const response = handleCorrectionRouteError(
      new CorrectionError("REVISION_CONFLICT", "moved", { currentRevisionId: "r2" }),
      "update"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { currentRevisionId: "r2" },
    });
  });

  // A decision that waited on the workspace row until its transaction ran out
  // of time, or lost a write conflict, met another writer: a conflict the
  // person can retry, not a failure of the server.
  it.each(["P2028", "P2034"])("answers a contended transaction (%s) as a locked workspace", async (code) => {
    const response = handleCorrectionRouteError(
      Object.assign(new Error("Transaction API error"), { code, clientVersion: "6" }),
      "update"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_LOCKED" });
  });

  // lock_timeout lasts for the whole transaction, so a later statement can
  // raise it outside lockWorkspace's own catch; it is the same conflict.
  it("answers a lock timeout raised by any statement as a locked workspace", async () => {
    const response = handleCorrectionRouteError(
      Object.assign(new Error("Raw query failed. Code: `55P03`. Message: `lock timeout`"), {
        code: "P2010",
        meta: { driverAdapterError: { cause: { kind: "postgres", originalCode: "55P03" } } },
      }),
      "update"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "WORKSPACE_LOCKED" });
  });

  it("still reports an unknown failure as a server error", async () => {
    const response = handleCorrectionRouteError(new Error("disk on fire"), "update");
    expect(response.status).toBe(500);
  });
});
