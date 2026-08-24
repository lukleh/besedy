import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportWebUpdateEvent } from "@/lib/service-worker/telemetry";

describe("web update telemetry client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a coarse route group without sending the catalog or event ID", () => {
    window.history.replaceState({}, "", "/catalog/private-catalog/event/42?token=secret");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    reportWebUpdateEvent({
      event: "apply_blocked",
      attemptId: "attempt-1",
      blockerKinds: ["unsaved-changes"],
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload).toEqual({
      event: "apply_blocked",
      attemptId: "attempt-1",
      blockerKinds: ["unsaved-changes"],
      routeGroup: "catalog-event",
    });
    expect(String(request.body)).not.toContain("private-catalog");
    expect(String(request.body)).not.toContain("token");
  });
});
