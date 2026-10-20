import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/lib/db", () => ({ default: {} }));

import { CONTRIBUTOR_TERMS, requireContributorConsent } from "@/lib/correction/consent";

function clientWith(row: { acceptedAt: Date } | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  return {
    client: { transcriptContributorConsent: { findUnique } } as never,
    findUnique,
  };
}

describe("contributor consent", () => {
  it("lets a person who accepted the current terms write", async () => {
    const { client, findUnique } = clientWith({ acceptedAt: new Date() });
    await expect(requireContributorConsent(client, "user-1")).resolves.toBeUndefined();
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { actorKey_termsVersion: { actorKey: "user-1", termsVersion: CONTRIBUTOR_TERMS.version } },
      })
    );
  });

  it("refuses a person who has not accepted them, naming the version", async () => {
    const { client } = clientWith(null);
    await expect(requireContributorConsent(client, "user-1")).rejects.toMatchObject({
      code: "CONSENT_REQUIRED",
      statusCode: 403,
      details: { termsVersion: CONTRIBUTOR_TERMS.version },
    });
  });

  it("states what the consent is for", () => {
    expect(CONTRIBUTOR_TERMS.text).toMatch(/zveřejněny/);
    expect(CONTRIBUTOR_TERMS.text).toMatch(/trénování/);
    expect(CONTRIBUTOR_TERMS.text).toMatch(/poslechl/);
    expect(CONTRIBUTOR_TERMS.text).toMatch(/rychlostí přehrávání/);
  });

  // The accepted text is stored with each consent row, so a changed text must
  // come with a new version. Changing CONTRIBUTOR_TERMS.text requires bumping
  // `version` and updating PINNED.textSha256 here in the same change.
  const PINNED = { version: "2026-10-20", textSha256: "6d5cd4d489e49437103e2c9272f75465d616c526f4da1c622e689a1a7826827e" };

  it("pins the terms text to its version", () => {
    expect(CONTRIBUTOR_TERMS.version).toBe(PINNED.version);
    expect(createHash("sha256").update(CONTRIBUTOR_TERMS.text).digest("hex")).toBe(PINNED.textSha256);
  });
});
