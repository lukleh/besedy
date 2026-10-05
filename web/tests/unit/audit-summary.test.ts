import { describe, expect, it } from "vitest";
import { buildAuditSummary } from "@/lib/audit/model";

function summary(action: string, payload: Record<string, unknown> | null) {
  return buildAuditSummary({
    action,
    resource: "catalog_access",
    resourceId: "user-1:20260101_000000",
    payload,
    actorSnapshot: null,
    subjectSnapshot: { type: "user", id: "user-1", label: "pat@example.com", catalogId: "20260101_000000" },
  });
}

describe("buildAuditSummary grant roles", () => {
  it("headlines the role of a grant event", () => {
    expect(summary("CATALOG_ACCESS_GRANTED", { role: "reader" })).toBe(
      "reader access granted to pat@example.com for 20260101_000000"
    );
    expect(summary("CATALOG_ACCESS_REVOKED", { role: "curator" })).toBe(
      "curator access revoked for pat@example.com for 20260101_000000"
    );
    expect(summary("PENDING_CATALOG_GRANT_CREATED", { role: "listener" })).toBe(
      "Pending listener grant created for pat@example.com for 20260101_000000"
    );
  });

  it("prefers the role when a payload carries both", () => {
    expect(summary("CATALOG_ACCESS_GRANTED", { accessLevel: "EDITOR", role: "curator" })).toBe(
      "curator access granted to pat@example.com for 20260101_000000"
    );
  });

  it("does not headline the retired access level of an old record", () => {
    // Records from before the role rework are history and are not rewritten.
    expect(summary("CATALOG_ACCESS_GRANTED", { accessLevel: "EDITOR" })).toBe(
      "Catalog access granted to pat@example.com for 20260101_000000"
    );
    expect(summary("CATALOG_ACCESS_REVOKED", { previousAccessLevel: "VIEWER" })).toBe(
      "Catalog access revoked for pat@example.com for 20260101_000000"
    );
    expect(summary("PENDING_CATALOG_GRANT_CREATED", { accessLevel: "LISTENER" })).toBe(
      "Pending catalog grant created for pat@example.com for 20260101_000000"
    );
  });
});
