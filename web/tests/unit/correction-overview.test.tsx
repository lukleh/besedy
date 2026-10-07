import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CorrectionOverviewPage,
  formatEventDate,
  orderForTab,
} from "@/components/correction/correction-overview";
import type { OverviewItem } from "@/components/correction/correction-types";
import { fetchJson } from "@/lib/api/fetch-json";
import { formatClock, formatHoursMinutes } from "@/lib/correction/format";
import {
  deriveReaderState,
  deriveWorkStage,
  inOverviewTab,
  OVERVIEW_TABS,
} from "@/lib/correction/overview-status";

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
    work: "in_progress",
    reader: "unpublished",
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
    changedSinceReaderPublication: 0,
    publication: { inFlight: null },
    ...overrides,
  };
}

function overview(workspaces: OverviewItem[], notStarted: OverviewItem[] = [], canPublish = true) {
  const byTab = Object.fromEntries(
    OVERVIEW_TABS.map((tab) => [tab, { count: 0, seconds: 0 }])
  ) as Record<string, { count: number; seconds: number }>;
  for (const entry of [...workspaces, ...notStarted]) {
    for (const tab of OVERVIEW_TABS) {
      if (!inOverviewTab(entry, tab)) continue;
      byTab[tab].count += 1;
      byTab[tab].seconds += entry.recording.durationSeconds;
    }
  }
  return {
    catalogId: CATALOG_ID,
    canPublish,
    summary: { byTab },
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

describe("deriveWorkStage", () => {
  it("is not started without a workspace", () => {
    expect(deriveWorkStage({ hasWorkspace: false, eligible: false })).toBe("not_started");
  });

  it("is in progress until every span is done, and done after", () => {
    expect(deriveWorkStage({ hasWorkspace: true, eligible: false })).toBe("in_progress");
    expect(deriveWorkStage({ hasWorkspace: true, eligible: true })).toBe("done");
  });
});

describe("deriveReaderState", () => {
  const base = { readerPublished: false, inFlight: false, changedSinceReaderPublication: 0 };

  it("is unpublished until a snapshot reaches readers", () => {
    expect(deriveReaderState(base)).toBe("unpublished");
  });

  it("is current when the snapshot matches the live text", () => {
    expect(deriveReaderState({ ...base, readerPublished: true })).toBe("current");
  });

  // Readers see the old snapshot while the live text moves on; a curator has
  // to be able to tell, or an edit after publication would go unnoticed.
  it("notices edits made after publication", () => {
    expect(deriveReaderState({ ...base, readerPublished: true, changedSinceReaderPublication: 3 })).toBe("stale");
  });

  it("reports a publication on its way before anything else", () => {
    expect(
      deriveReaderState({ ...base, inFlight: true, readerPublished: true, changedSinceReaderPublication: 2 })
    ).toBe("publishing");
  });
});

describe("formatting", () => {
  it("writes lengths in hours and minutes", () => {
    expect(formatHoursMinutes(0)).toBe("0 min");
    expect(formatHoursMinutes(40 * 60)).toBe("40 min");
    expect(formatHoursMinutes(3 * 3600)).toBe("3 h");
    expect(formatHoursMinutes(3 * 3600 + 25 * 60)).toBe("3 h 25 min");
  });

  it("writes a position in a recording with hours only once it passes one", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65.9)).toBe("1:05");
    expect(formatClock(3599)).toBe("59:59");
    expect(formatClock(3600)).toBe("1:00:00");
    expect(formatClock(3 * 3600 + 7 * 60 + 5)).toBe("3:07:05");
    expect(formatClock(-4)).toBe("0:00");
  });

  it("writes as much of the event date as is known", () => {
    const recording = item("a").recording;
    expect(formatEventDate(recording)).toBe("2026-03-14");
    expect(formatEventDate({ ...recording, dateDay: null })).toBe("2026-03");
    expect(formatEventDate({ ...recording, dateMonth: null, dateDay: null })).toBe("2026");
    expect(formatEventDate({ ...recording, dateYear: null })).toBeNull();
  });
});

describe("inOverviewTab", () => {
  it("lists what still wants this person under mine, and nothing they have finished", () => {
    const wants = item("a", { touchedByMe: true, mine: { approved: 3, disapproved: 0, waitingOnOthers: 3, open: 97 } });
    const finished = item("b", { touchedByMe: true, mine: { approved: 100, disapproved: 0, waitingOnOthers: 0, open: 0 } });
    const untouched = item("c", { mine: { approved: 0, disapproved: 0, waitingOnOthers: 0, open: 100 } });

    expect(inOverviewTab(wants, "mine")).toBe(true);
    expect(inOverviewTab(finished, "mine")).toBe(false);
    expect(inOverviewTab(untouched, "mine")).toBe(false);
  });

  it("offers a curator what is ready, on its way or finished again after publication", () => {
    expect(inOverviewTab(item("a", { work: "done" }), "to_publish")).toBe(true);
    expect(inOverviewTab(item("b", { reader: "publishing" }), "to_publish")).toBe(true);
    expect(inOverviewTab(item("c", { work: "done", reader: "stale" }), "to_publish")).toBe(true);
    // Edited again but not finished: nothing to publish yet.
    expect(inOverviewTab(item("d", { work: "in_progress", reader: "stale" }), "to_publish")).toBe(false);
    expect(inOverviewTab(item("e", { work: "done", reader: "current" }), "to_publish")).toBe(false);
    expect(inOverviewTab(item("f"), "to_publish")).toBe(false);
  });

  // The reason the status has two axes: correcting a published recording
  // again is work in progress, and has to be found where that work is listed.
  it("lists a published recording that is being corrected again as in progress", () => {
    const reopened = item("a", { work: "in_progress", reader: "stale" });
    const disputed = item("b", { work: "in_progress", reader: "current" });

    expect(inOverviewTab(reopened, "in_progress")).toBe(true);
    expect(inOverviewTab(reopened, "published")).toBe(true);
    expect(inOverviewTab(disputed, "in_progress")).toBe(true);
    expect(inOverviewTab(item("c", { work: "done", reader: "current" }), "in_progress")).toBe(false);
  });

  it("keeps a recording that was edited after publication among the published", () => {
    expect(inOverviewTab(item("a", { work: "done", reader: "stale" }), "published")).toBe(true);
    expect(inOverviewTab(item("b", { work: "done", reader: "current" }), "published")).toBe(true);
  });
});

describe("orderForTab", () => {
  it("puts what still wants this person first among the work in progress", () => {
    const quiet = item("quiet");
    const wanted = item("wanted", { mine: { approved: 0, disapproved: 0, waitingOnOthers: 0, open: 5 } });
    const alsoQuiet = item("also");

    expect(orderForTab([quiet, wanted, alsoQuiet], "in_progress").map((row) => row.workspaceId)).toEqual([
      "ws-wanted",
      "ws-quiet",
      "ws-also",
    ]);
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
        [item("a"), item("b", { work: "done" }), item("c", { work: "done", reader: "current" })],
        [item("n", { work: "not_started", workspaceId: null, progress: null, mine: null })]
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
    expect(rows[0]).toHaveAttribute("data-work", "not_started");
    expect(within(rows[0]).getByRole("link", { name: "actions.start" })).toBeInTheDocument();
  });

  it("offers publishing to a publisher and only opening to everyone else", async () => {
    const ready = item("ready", { work: "done" });

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
          work: "done",
          reader: "publishing",
          publication: { inFlight: { status: "ACTIVATING", error: { code: "INDEX_FAILED", message: "boom" } } },
        }),
      ])
    );

    renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-to_publish"));

    expect(screen.getByText("reader.publishingStalled")).toBeInTheDocument();
  });

  it("shows the work and what readers see side by side", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([item("a", { work: "in_progress", reader: "stale", changedSinceReaderPublication: 2 })])
    );

    renderPage();
    const [row] = await screen.findAllByTestId("correction-overview-row");

    expect(within(row).getByText("work.in_progress")).toBeInTheDocument();
    expect(within(row).getByText("reader.stale")).toBeInTheDocument();
    expect(within(row).getByText('changedSincePublication {"count":2}')).toBeInTheDocument();
  });

  it("explains an empty tab instead of showing nothing", async () => {
    fetchJsonMock.mockResolvedValue(overview([item("a")]));

    renderPage();
    await userEvent.click(await screen.findByTestId("correction-overview-filter-published"));

    expect(screen.getByText("empty.published")).toBeInTheDocument();
    expect(screen.queryByTestId("correction-overview-row")).not.toBeInTheDocument();
  });

  it("says that the groups overlap when a recording is in two of them", async () => {
    fetchJsonMock.mockResolvedValue(overview([item("a", { work: "in_progress", reader: "stale" })]));

    renderPage();

    expect(await screen.findByTestId("correction-overview-overlap")).toHaveTextContent("summary.overlap");
  });

  it("says nothing about overlap when every recording is in one group", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([item("a"), item("b", { work: "done" }), item("c", { work: "done", reader: "current" })])
    );

    renderPage();
    await screen.findByTestId("correction-overview-summary");

    expect(screen.queryByTestId("correction-overview-overlap")).not.toBeInTheDocument();
  });

  it("totals the hours per stage in the summary", async () => {
    fetchJsonMock.mockResolvedValue(
      overview([
        item("a"),
        item("b", { work: "done", reader: "current", recording: { ...item("b").recording, durationSeconds: 7200 } }),
      ])
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
