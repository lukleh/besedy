import { describe, expect, it } from "vitest";
import type { CatalogRole } from "@/generated/prisma/client";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import {
  canAdministerCorrection,
  canCorrectTranscripts,
  canEditCorrectionGuide,
  canPublishTranscript,
} from "@/lib/policy/correction";

const grant = (role: CatalogRole, extras: string[] = []): CatalogGrant => ({
  role,
  extras,
});

const context = (role: CatalogRole | null, isCatalogAdmin = false) => ({
  catalogExists: true,
  canEnterPortal: true,
  catalogGrant: role === null ? null : grant(role),
  isCatalogAdmin,
});

describe("correction policy", () => {
  it("opens the correction surface to a corrector", () => {
    expect(canCorrectTranscripts(context("corrector"))).toBe(true);
  });

  it("does not let a corrector publish", () => {
    expect(canPublishTranscript(context("corrector"))).toBe(false);
  });

  it("keeps both away from a plain reader", () => {
    expect(canCorrectTranscripts(context("reader"))).toBe(false);
    expect(canPublishTranscript(context("reader"))).toBe(false);
  });

  it("keeps both away from a listener, who cannot read transcripts at all", () => {
    expect(canCorrectTranscripts(context("listener"))).toBe(false);
    expect(canPublishTranscript(context("listener"))).toBe(false);
  });

  it("gives a curator correction and publication", () => {
    expect(canCorrectTranscripts(context("curator"))).toBe(true);
    expect(canPublishTranscript(context("curator"))).toBe(true);
  });

  it("gives a catalog administrator everything, including the guide", () => {
    expect(canCorrectTranscripts(context(null, true))).toBe(true);
    expect(canPublishTranscript(context(null, true))).toBe(true);
    expect(canEditCorrectionGuide(context(null, true))).toBe(true);
    expect(canAdministerCorrection(context(null, true))).toBe(true);
  });

  it("keeps archiving and recovery away from a curator", () => {
    // Archiving a workspace and rolling back a publication change what every
    // consumer resolves, so they sit with catalog configuration rather than
    // with the editorial right to publish.
    expect(canAdministerCorrection(context("curator"))).toBe(false);
    expect(canAdministerCorrection(context("corrector"))).toBe(false);
    expect(canAdministerCorrection(context("host"))).toBe(false);
  });

  it("keeps the guide out of a curator's hands, since it is catalog configuration", () => {
    expect(canEditCorrectionGuide(context("curator"))).toBe(false);
    expect(canEditCorrectionGuide(context("corrector"))).toBe(false);
  });

  it("denies everyone when the catalog does not exist", () => {
    expect(
      canCorrectTranscripts({
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: grant("curator"),
        isCatalogAdmin: false,
      })
    ).toBe(false);
  });
});
