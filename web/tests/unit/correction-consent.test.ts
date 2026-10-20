import { describe, expect, it, vi } from "vitest";

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
  });
});
