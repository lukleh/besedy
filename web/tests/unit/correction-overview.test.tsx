import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CorrectionOverviewPage,
  formatEventDate,
  formatHours,
  matchesFilter,
} from "@/components/correction/correction-overview";
import type { OverviewItem } from "@/components/correction/correction-types";
import { fetchJson } from "@/lib/api/fetch-json";
import { deriveOverviewStatus } from "@/lib/correction/overview-status";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  useLocale: () => "cs",
}));

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {},
  fetchJson: vi.fn(),
}));

const CATALOG_ID = "20251225_120000";
const fetchJsonMock = vi.mocked(fetchJson);

const zeroStates = { needs_attention: 0, done: 0, needs_second_approval: 0, not_reviewed: 0 };

function item(hash: string, overrides: Partial<OverviewItem> = {}): OverviewItem {
  return {
    status: "in_progress",
    recording: {
      audioHash: hash.padEnd(64, "0"),
      title: `Recording ${hash}`,
      eventId: 1,
      eventTitle: null,
      locationName: "Uhříněves",
      dateYear: 2026,
      dateMonth: 3,
      dateDay: 14,
      durationSeconds: 3600,
    },
    workspaceId: `ws-${hash}`,
    progress: {
      spanCount: 100,
      totalSeconds: 3600,
      counts: { ...zeroStates, done: 40, needs_second_approval: 10, not_reviewed: 50 },
      seconds: { ...zeroStates, done: 1440, needs_second_approval: 360, not_reviewed: 1800 },
    },
    mine: { approved: 0, disapproved: 0, waitingOnOthers: 0, open: 0 },
    touchedByMe: false,
    lastActivity: null,
    myLastActivityAt: null,
    eligible: false,
    changedSinceReaderPublication: 0,
    publication: { inFlight: null },
    ...overrides,
  };
}

function overview(workspaces: OverviewItem[], notStarted: OverviewItem[] = [], canPublish = true) {
  const byStatus = Object.fromEntries(
    ["not_started", "in_progress", "ready", "publishing", "published", "published_changed"].map((status) => [
      status,
      { count: 0, seconds: 0 },
    ])
  ) as Record<string, { count: number; seconds: number }>;
  for (const entry of [...workspaces, ...notStarted]) {
    byStatus[entry.status].count += 1;
    byStatus[entry.status].seconds += entry.recording.durationSeconds;
  }
  return {
    catalogId: CATALOG_ID,
    canPublish,
    summary: { byStatus },
    workspaces,
    notStarted: { total: notStarted.length, items: notStarted },
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CorrectionOverviewPage catalogId={CATALOG_ID} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchJsonMock.mockReset();
});

describe("deriveOverviewStatus", () => {
  const base = { eligible: false, readerPublished: false, inFlight: false, changedSinceReaderPublication: 0 };

  it("is in progress until every span is done", () => {
    expect(deriveOverviewStatus(base)).toBe("in_progress");
  });

  it("is ready once every span is done and nothing is published", () => {
    expect(deriveOverviewStatus({ ...base, eligible: true })).toBe("ready");
  });

  it("is published when the snapshot matches the live text", () => {
    expect(deriveOverviewStatus({ ...base, readerPublished: true, eligible: true })).toBe("published");
  });

  // Readers see the old snapshot while the live text moves on; a curator has
  // to be able to tell, or an edit after publication would go unnoticed.
  it("notices edits made after publication", () => {
    expect(
      deriveOverviewStatus({ ...base, readerPublished: true, changedSinceReaderPublication: 3 })
    ).toBe("published_changed");
  });

  it("reports a publication on its way before anything else", () => {
    expect(
      deriveOverviewStatus({ ...base, inFlight: true, readerPublished: true, changedSinceReaderPublication: 2 })
    ).toBe("publishing");
  });
});

describe("formatting", () => {
  it("writes lengths in hours and minutes", () => {
    expect(formatHours(0)).toBe("0 min");
    expect(formatHours(40 * 60)).toBe("40 min");
    expect(formatHours(3 * 3600)).toBe("3 h");
    expect(formatHours(3 * 3600 + 25 * 60)).toBe("3 h 25 min");
  });

  it("writes as much of the event date as is known", () => {
    const recording = item("a").recording;
    expect(formatEventDate(recording)).toBe("2026-03-14");
    expect(formatEventDate({ ...recording, dateDay: null })).toBe("2026-03");
    expect(formatEventDate({ ...recording, dateMonth: null, dateDay: null })).toBe("2026");
    expect(formatEventDate({ ...recording, dateYear: null })).toBeNull();
  });
});

describe("matchesFilter", () => {
  it("lists what still wants this person under mine, and nothing they have finished", () => {
    const wants = item("a", { touchedByMe: true, mine: { approved: 3, disapproved: 0, waitingOnOthers: 3, open: 97 } });
    const finished = item("b", { touchedByMe: true, mine: { approved: 100, disapproved: 0, waitingOnOthers: 0, open: 0 } });
    const untouched = item("c", { mine: { approved: 0, disapproved: 0, waitingOnOthers: 0, open: 100 } });

    expect(matchesFilter(wants, "mine")).toBe(true);
    expect(matchesFilter(finished, "mine")).toBe(false);
    expect(matchesFilter(untouched, "mine")).toBe(false);
  });

  it("offers a curator what is ready, on its way or edited after publication", () => {
    expect(matchesFilter(item("a", { status: "ready", eligible: true }), "to_publish")).toBe(true);
    expect(matchesFilter(item("b", { status: "publishing" }), "to_publish")).toBe(true);
    expect(matchesFilter(item("c", { status: "published_changed", eligible: true }), "to_publish")).toBe(true);
    // Edited again but not finished: nothing to publish yet.
    expect(matchesFilter(item("d", { status: "published_changed", eligible: false }), "to_publish")).toBe(false);
    expect(matchesFilter(item("e", { status: "in_progress" }), "to_publish")).toBe(false);
  });

  it("keeps a recording that was edited after publication among the published", () => {
    expect(matchesFilter(item("a", { status: "published_changed" }), "published")).toBe(true);
    expect(matchesFilter(item("b", { status: "published" }), "published")).toBe(true);
  });
});

describe("CorrectionOverviewPage", () => {
  it("opens on what wants this person and shows their share", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([
        item("mine", {
          touchedByMe: true,
          mine: { approved: 30, disapproved: 1, waitingOnOthers: 20, open: 70 },
          lastActivity: { at: new Date(Date.now() - 3_600_000).toISOString(), actorName: "Jana" },
        }),
        item("theirs"),
      ])
    );

    renderPage();

    const rows = await screen.findAllByTestId("correction-overview-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("Recording mine")).toBeInTheDocument();
    const mine = within(rows[0]).getByTestId("correction-overview-mine");
    expect(mine).toHaveTextContent('mine.approved {"count":30}');
    expect(mine).toHaveTextContent('mine.waiting {"count":20}');
    expect(mine).toHaveTextContent('mine.disapproved {"count":1}');
    expect(mine).toHaveTextContent('mine.open {"count":70}');
    expect(within(rows[0]).getByRole("link", { name: "actions.continue" })).toHaveAttribute(
      "href",
      `/catalog/${CATALOG_ID}/recording/${"mine".padEnd(64, "0")}/correction`
    );
    expect(screen.getByTestId("correction-overview-filter-mine")).toHaveAttribute("aria-pressed", "true");
  });

  // A row of zeros says nothing the bar does not.
  it("leaves out the parts of a person's share that are zero", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([
        item("a", { touchedByMe: true, mine: { approved: 12, disapproved: 0, waitingOnOthers: 0, open: 88 } }),
      ])
    );

    renderPage();

    const mine = await screen.findByTestId("correction-overview-mine");
    expect(mine).toHaveTextContent("mine.approved");
    expect(mine).toHaveTextContent("mine.open");
    expect(mine).not.toHaveTextContent("mine.waiting");
    expect(mine).not.toHaveTextContent("mine.disapproved");
  });

  it("names the event only when it adds something to the title", async () => {
    const same = item("a", { touchedByMe: true, mine: { approved: 1, disapproved: 0, waitingOnOthers: 0, open: 9 } });
    same.recording = { ...same.recording, title: "Podzimní beseda", eventTitle: "Podzimní beseda" };
    const other = item("b", { touchedByMe: true, mine: { approved: 1, disapproved: 0, waitingOnOthers: 0, open: 9 } });
    other.recording = { ...other.recording, title: "Part 1", eventTitle: "Podzimní beseda" };
    fetchJsonMock.mockResolvedValue(overview([same, other]));

    renderPage();

    const rows = await screen.findAllByTestId("correction-overview-row");
    const subtitles = rows.map((row) => row.querySelector("p")?.textContent ?? "");
    expect(subtitles[0]).not.toContain("Podzimní beseda");
    expect(subtitles[1]).toContain("Podzimní beseda");
  });

  it("falls back to what is in progress when nothing wants this person", async () => {
    fetchJsonMock.mockResolvedValue(overview([item("a"), item("b")]));

    renderPage();

    expect(await screen.findAllByTestId("correction-overview-row")).toHaveLength(2);
    expect(screen.getByTestId("correction-overview-filter-in_progress")).toHaveAttribute("aria-pressed", "true");
  });

  it("counts every tab, and shows the recordings nobody has started", async () => {
    fetchJsonMock.mockResolvedValue(
      overview(
        [item("a"), item("b", { status: "ready", eligible: true }), item("c", { status: "published" })],
        [item("n", { status: "not_started", workspaceId: null, progress: null, mine: null })]
      )
    );

    renderPage();
    await screen.findAllByTestId("correction-overview-row");

    expect(screen.getByTestId("correction-overview-filter-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("correction-overview-filter-to_publish")).toHaveTextContent("1");
    expect(screen.getByTestId("correction-overview-filter-published")).toHaveTextContent("1");
    expect(screen.getByTestId("correction-overview-filter-not_started")).toHaveTextContent("1");

    await userEvent.click(screen.getByTestId("correction-overview-filter-not_started"));

    const rows = screen.getAllByTestId("correction-overview-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("data-status", "not_started");
    expect(within(rows[0]).getByRole("link", { name: "actions.start" })).toBeInTheDocument();
  });

  it("offers publishing to a publisher and only opening to everyone else", async () => {
    const ready = item("ready", { status: "ready", eligible: true });

    fetchJsonMock.mockResolvedValue(overview([ready], [], true));
    const { unmount } = renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-to_publish"));
    expect(screen.getByRole("link", { name: "actions.publish" })).toBeInTheDocument();
    unmount();

    fetchJsonMock.mockResolvedValue(overview([ready], [], false));
    renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-to_publish"));
    expect(screen.queryByRole("link", { name: "actions.publish" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "actions.open" })).toBeInTheDocument();
  });

  it("says when a publication stalled", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([
        item("a", {
          status: "publishing",
          publication: { inFlight: { status: "ACTIVATING", error: { code: "INDEX_FAILED", message: "boom" } } },
        }),
      ])
    );

    renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-to_publish"));

    expect(screen.getByText("status.publishingStalled")).toBeInTheDocument();
  });

  it("explains an empty tab instead of showing nothing", async () => {
    fetchJsonMock.mockResolvedValue(overview([item("a")]));

    renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-published"));

    expect(screen.getByText("empty.published")).toBeInTheDocument();
    expect(screen.queryByTestId("correction-overview-row")).not.toBeInTheDocument();
  });

  it("totals the hours per stage in the summary", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([item("a"), item("b", { status: "published", recording: { ...item("b").recording, durationSeconds: 7200 } })])
    );

    renderPage();
    const summary = await screen.findByTestId("correction-overview-summary");

    expect(within(summary).getByText("1 h")).toBeInTheDocument();
    expect(within(summary).getByText("2 h")).toBeInTheDocument();
  });

  it("reports a failure to load", async () => {
    fetchJsonMock.mockRejectedValue(new Error("down"));

    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("loadFailed");
  });
});
