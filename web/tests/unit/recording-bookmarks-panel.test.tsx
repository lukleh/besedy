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
vi.mock("@/hooks/use-return-href", () => ({
  useReturnHref: (target: string) => `${target}?backTo=%2Fcatalog%2Fc1%2Fevent%2F7`,
}));

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

  it("finds the line in unsorted and overlapping model output", () => {
    const messy = [
      { start: 10, end: 12, text: "Later" },
      { start: 0, end: 5, text: "First" },
      { start: 3, end: 8, text: "Overlap" },
    ];
    // Spoken: the first line in transcript order that covers the time, as the viewer highlights it.
    expect(findTranscriptExcerpt(messy, 4)).toBe("First");
    expect(findTranscriptExcerpt(messy, 6)).toBe("Overlap");
    // In a pause: the latest line to start before it, wherever it sits in the list.
    expect(findTranscriptExcerpt(messy, 9)).toBe("Overlap");
    expect(findTranscriptExcerpt(messy, 30)).toBe("Later");
  });

  it("is empty before the first line and without a transcript", () => {
    expect(findTranscriptExcerpt([{ start: 3, end: 4, text: "x" }], 1)).toBeNull();
    expect(findTranscriptExcerpt([], 1)).toBeNull();
  });
});

function renderPanel(currentTime: number, { isPending = false } = {}) {
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
    create: { mutate, isPending },
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

  it("does not take B pressed inside a dialog, menu or slider as the shortcut", () => {
    renderPanel(3);
    for (const role of ["dialog", "alertdialog", "menu", "listbox", "slider"]) {
      const container = document.createElement("div");
      container.setAttribute("role", role);
      const button = document.createElement("button");
      container.appendChild(button);
      document.body.appendChild(container);

      fireEvent.keyDown(button, { code: "KeyB", key: "b" });

      expect(screen.queryByTestId("bookmark-draft")).toBeNull();
      container.remove();
    }
  });

  it("saves once while a save is in flight, however often Ctrl+Enter is pressed", () => {
    const { mutate } = renderPanel(7, { isPending: true });

    fireEvent.click(screen.getByTestId("bookmark-add"));
    const input = screen.getByTestId("bookmark-comment-input");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });

    expect(mutate).not.toHaveBeenCalled();
  });

  it("links to all bookmarks with a way back to this page", () => {
    renderPanel(0);

    expect(screen.getByRole("link", { name: "All bookmarks" })).toHaveAttribute(
      "href",
      "/bookmarks?backTo=%2Fcatalog%2Fc1%2Fevent%2F7",
    );
  });

  it("plays from a bookmark and shows its comment and excerpt", () => {
    const { onSeek } = renderPanel(0);

    expect(screen.getByText("Key question")).toBeTruthy();
    expect(screen.getByText("„Proč?“")).toBeTruthy();
    fireEvent.click(screen.getByTestId("bookmark-seek"));

    expect(onSeek).toHaveBeenCalledWith(125);
  });
});
