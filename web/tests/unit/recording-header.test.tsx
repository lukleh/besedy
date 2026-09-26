import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RecordingHeader,
  type RecordingHeadingContext,
} from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content-sections";
import type { CatalogEntryResponse } from "@/types/catalog";

const HASH = "a".repeat(64);
let locale = "en";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => locale,
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

function renderHeading(overrides: Partial<CatalogEntryResponse>, headingContext?: RecordingHeadingContext) {
  const recording = {
    hash: HASH,
    filename: "recording.wav",
    ...overrides,
  } as CatalogEntryResponse;
  render(<RecordingHeader hash={HASH} recording={recording} headingContext={headingContext} />);
  return screen.getByRole("heading", { level: 1 }).textContent;
}

describe("RecordingHeader", () => {
  beforeEach(() => {
    locale = "en";
  });

  it("shows title, full date and location together", () => {
    const heading = renderHeading({
      dateYear: 2006,
      dateMonth: 6,
      dateDay: 18,
      location: { id: 1, name: "Library" },
      curatedTitle: "Mind Mapping 4",
    });

    expect(heading).toBe("Mind Mapping 4 · Jun 18, 2006 · Library");
  });

  it("keeps date and location when the date has no day", () => {
    const heading = renderHeading({
      dateYear: 2006,
      dateMonth: 6,
      dateDay: null,
      location: { id: 1, name: "Library" },
      curatedTitle: "Mind Mapping 4",
    });

    expect(heading).toBe("Mind Mapping 4 · June 2006 · Library");
  });

  it("formats Czech full and month-only dates", () => {
    locale = "cs";
    const recording = { location: { id: 1, name: "Městská knihovna" }, curatedTitle: "Mapování mysli 4" };

    expect(renderHeading({ ...recording, dateYear: 2006, dateMonth: 6, dateDay: 18 })).toBe(
      "Mapování mysli 4 · 18. Června 2006 · Městská knihovna"
    );
    cleanup();
    expect(renderHeading({ ...recording, dateYear: 2006, dateMonth: 6 })).toBe(
      "Mapování mysli 4 · Červen 2006 · Městská knihovna"
    );
  });

  it("shows a year-only date", () => {
    const heading = renderHeading({ dateYear: 2006, location: { id: 1, name: "Library" } });

    expect(heading).toBe("2006 · Library");
  });

  it("shows only the year when the month is missing", () => {
    const heading = renderHeading({ dateYear: 2006, dateDay: 18 });

    expect(heading).toBe("2006");
  });

  it("ignores a month or day without a year", () => {
    const heading = renderHeading({ dateMonth: 6, dateDay: 18, location: { id: 1, name: "Library" } });

    expect(heading).toBe("Library");
  });

  it("leaves the source title out when there is a date or location", () => {
    const heading = renderHeading({ dateYear: 2006, title: "10. Června 1" });

    expect(heading).toBe("2006");
  });

  it("does not replace a blank curated title with the source title", () => {
    const heading = renderHeading({ dateYear: 2006, curatedTitle: "  ", title: "10. Června 1" });

    expect(heading).toBe("2006");
  });

  it("falls back to the source title when there is no date, location or curated title", () => {
    const heading = renderHeading({ curatedTitle: " ", title: " Source title " });

    expect(heading).toBe("Source title");
  });

  it("skips a source title that is the audio hash in the fallback", () => {
    const heading = renderHeading({ title: HASH });

    expect(heading).toBe("recording.wav");
  });

  it("trims parts and drops blank ones", () => {
    const heading = renderHeading({ dateYear: 2006, curatedTitle: "  ", location: { id: 1, name: " Library " } });

    expect(heading).toBe("2006 · Library");
  });

  it("falls back to the filename when there is no date, location or title", () => {
    const heading = renderHeading({ curatedTitle: " " });

    expect(heading).toBe("recording.wav");
  });

  it("does not add the filename when date or location exist", () => {
    const heading = renderHeading({ location: { id: 1, name: "Library" } });

    expect(heading).toBe("Library");
  });

  it("keeps the recording title with a passed date and location", () => {
    const heading = renderHeading(
      {
        curatedTitle: "Recording title",
        dateYear: 2006,
        dateMonth: 6,
        dateDay: 18,
        location: { id: 1, name: "Recording place" },
      },
      { dateYear: 2006, dateMonth: 6, dateDay: null, locationName: "Event place" }
    );

    expect(heading).toBe("Recording title · June 2006 · Event place");
  });
});
