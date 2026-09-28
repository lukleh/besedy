import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CorrectionProgressPanel } from "@/components/correction/correction-progress-panel";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const CATALOG_ID = "20251225_120000";
const HASH = "a".repeat(64);

describe("CorrectionProgressPanel", () => {
  // What a reader sees instead of an unpublished transcript: how far checking
  // has got, in audio, and nothing about who is doing it or which passages
  // are disputed.
  it("shows progress in audio once correction has started", () => {
    render(
      <CorrectionProgressPanel
        state={{
          started: true,
          spanCount: 120,
          totalDurationSeconds: 3600,
          reviewedOnceDurationSeconds: 1800,
          fullyApprovedDurationSeconds: 900,
          reviewedOnceRatio: 0.5,
          fullyApprovedRatio: 0.25,
        }}
        catalogId={CATALOG_ID}
        hash={HASH}
      />
    );

    expect(screen.getByText("readerTitle")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "reviewedOnce" })).toHaveAttribute(
      "aria-valuenow",
      "50"
    );
    expect(screen.getByRole("progressbar", { name: "fullyApproved" })).toHaveAttribute(
      "aria-valuenow",
      "25"
    );
    expect(screen.queryByRole("link", { name: "openSurface" })).not.toBeInTheDocument();
  });

  it("says correction has not started and offers the surface to a corrector", () => {
    render(
      <CorrectionProgressPanel
        state={{
          started: false,
          spanCount: 0,
          totalDurationSeconds: 0,
          reviewedOnceDurationSeconds: 0,
          fullyApprovedDurationSeconds: 0,
          reviewedOnceRatio: 0,
          fullyApprovedRatio: 0,
        }}
        catalogId={CATALOG_ID}
        hash={HASH}
        canCorrect
      />
    );

    expect(screen.getByText("notStarted")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openSurface" })).toHaveAttribute(
      "href",
      `/catalog/${CATALOG_ID}/recording/${HASH}/correction`
    );
  });
});
