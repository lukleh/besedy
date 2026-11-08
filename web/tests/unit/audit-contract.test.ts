import { describe, expect, it } from "vitest";
import { mapAuditLogToListItem, type AuditLogRecord } from "@/lib/audit/model";

const current: AuditLogRecord = {
  id: "event", userId: "user", action: "LOGIN", resource: "auth", resourceId: "user",
  domain: "auth", subjectType: "user", outcome: "success", payloadVersion: 1,
  details: { audit: { payloadVersion: 1, domain: "auth", subjectType: "user", outcome: "success", summary: "Signed in", actorSnapshot: { type: "user", userId: "user" }, subjectSnapshot: { type: "user", id: "user" } } },
  ipAddress: null, userAgent: null, createdAt: new Date("2026-01-01"), user: null,
};

describe("current audit contract", () => {
  it("reads the saved summary rather than recreating history", () => {
    expect(mapAuditLogToListItem(current)).toMatchObject({ domain: "auth", outcome: "success", summary: "Signed in" });
  });
  it.each([
    { details: null }, { payloadVersion: null }, { domain: "content" }, { subjectType: null }, { outcome: "changed" },
    { details: { audit: { payloadVersion: 2 } } },
  ])("rejects missing or mismatched canonical metadata: %j", (change) => {
    expect(() => mapAuditLogToListItem({ ...current, ...change })).toThrow("current audit contract");
  });
});
