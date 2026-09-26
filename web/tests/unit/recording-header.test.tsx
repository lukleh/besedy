import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingHeader } from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content-sections";
import type { CatalogEntryResponse } from "@/types/catalog";

const HASH = "a".repeat(64);

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@/components/player/audio-player", () => ({
  AudioPlayer: () => null,
}));

vi.mock("@/components/transcript/transcript-stream-viewer", () => ({
  TranscriptStreamViewer: () => null,
}));

vi.mock("@/components/transcript/transcript-viewer", () => ({
  TranscriptViewer: () => null,
}));

function renderHeader(overrides: Partial<CatalogEntryResponse>) {
  const recording = {
    hash: HASH,
    filename: "recording.wav",
    ...overrides,
  } as CatalogEntryResponse;
  render(<RecordingHeader hash={HASH} recording={recording} />);
  return screen.getByRole("heading", { level: 1 });
}

describe("RecordingHeader", () => {
  it("shows full date, location and title together", () => {
    const heading = renderHeader({
      dateYear: 2006,
      dateMonth: 6,
      dateDay: 18,
      location: { id: 1, name: "Library" },
      curatedTitle: "Mind Mapping 4",
    });

    expect(heading).toHaveTextContent("Jun 18, 2006 · Library · Mind Mapping 4");
  });

  it("keeps date and location when the date has no day", () => {
    const heading = renderHeader({
      dateYear: 2006,
      dateMonth: 6,
      dateDay: null,
      location: { id: 1, name: "Library" },
      curatedTitle: "Mind Mapping 4",
    });

    expect(heading).toHaveTextContent("June 2006 · Library · Mind Mapping 4");
  });

  it("shows a year-only date", () => {
    const heading = renderHeader({ dateYear: 2006, location: { id: 1, name: "Library" } });

    expect(heading).toHaveTextContent("2006 · Library");
  });

  it("ignores a month or day without a year", () => {
    const heading = renderHeader({ dateMonth: 6, dateDay: 18, location: { id: 1, name: "Library" } });

    expect(heading).toHaveTextContent(/^Library$/);
  });

  it("falls back to the source title when there is no curated title", () => {
    const heading = renderHeader({ dateYear: 2006, title: "Source title" });

    expect(heading).toHaveTextContent("2006 · Source title");
  });

  it("falls back to the filename when there is no date, location or title", () => {
    const heading = renderHeader({});

    expect(heading).toHaveTextContent(/^recording\.wav$/);
  });

  it("does not add the filename when date or location exist", () => {
    const heading = renderHeader({ location: { id: 1, name: "Library" } });

    expect(heading).toHaveTextContent(/^Library$/);
  });
});
