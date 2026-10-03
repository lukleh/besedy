import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import {
  RecordingBookmarks,
  findTranscriptExcerpt,
} from "@/components/bookmarks/recording-bookmarks";
import type { useRecordingBookmarks } from "@/hooks/use-recording-bookmarks";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const LINES = [
  { start: 0, end: 4, text: "Dobrý večer." },
  { start: 6, end: 9, text: " Vítejte na besedě. " },
];

describe("findTranscriptExcerpt", () => {
  it.each([
    [2, "Dobrý večer."],
    // In the pause after a line, that line is what was last said.
    [5, "Dobrý večer."],
    [6, "Vítejte na besedě."],
    [20, "Vítejte na besedě."],
  ])("at %ss is %j", (time, expected) => {
    expect(findTranscriptExcerpt(LINES, time)).toBe(expected);
  });

  it("is empty before the first line and without a transcript", () => {
    expect(findTranscriptExcerpt([{ start: 3, end: 4, text: "x" }], 1)).toBeNull();
    expect(findTranscriptExcerpt([], 1)).toBeNull();
  });
});

function renderPanel(currentTime: number) {
  const mutate = vi.fn();
  const onSeek = vi.fn();
  const bookmarks = {
    bookmarks: [
      {
        id: "b1",
        positionSec: 125,
        comment: "Key question",
        excerpt: "Proč?",
        createdAt: "2026-10-03T12:00:00.000Z",
        updatedAt: "2026-10-03T12:00:00.000Z",
      },
    ],
    isLoading: false,
    isError: false,
    create: { mutate, isPending: false },
    update: { mutate: vi.fn(), isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
  } as unknown as ReturnType<typeof useRecordingBookmarks>;
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecordingBookmarks
        bookmarks={bookmarks}
        currentTime={currentTime}
        onSeek={onSeek}
        transcriptLines={LINES}
      />
    </NextIntlClientProvider>,
  );
  return { mutate, onSeek };
}

describe("RecordingBookmarks", () => {
  it("bookmarks the moment B was pressed, with the line spoken there", () => {
    const { mutate } = renderPanel(7.4);

    fireEvent.keyDown(document.body, { code: "KeyB", key: "b" });
    expect(screen.getByText("New bookmark at 00:00:07")).toBeTruthy();
    fireEvent.change(screen.getByTestId("bookmark-comment-input"), {
      target: { value: "Greeting" },
    });
    fireEvent.click(screen.getByTestId("bookmark-save"));

    expect(mutate).toHaveBeenCalledWith(
      { positionSec: 7.4, comment: "Greeting", excerpt: "Vítejte na besedě." },
      expect.any(Object),
    );
  });

  it("does not take B typed into a text field as the shortcut", () => {
    renderPanel(3);
    const input = document.createElement("input");
    document.body.appendChild(input);

    fireEvent.keyDown(input, { code: "KeyB", key: "b" });

    expect(screen.queryByTestId("bookmark-draft")).toBeNull();
    input.remove();
  });

  it("plays from a bookmark and shows its comment and excerpt", () => {
    const { onSeek } = renderPanel(0);

    expect(screen.getByText("Key question")).toBeTruthy();
    expect(screen.getByText("„Proč?“")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bookmark-seek"));

    expect(onSeek).toHaveBeenCalledWith(125);
  });
});
