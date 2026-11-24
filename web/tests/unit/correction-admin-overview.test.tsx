import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CorrectionAdminOverviewPage,
  deriveNeedsAction,
  groupRecordings,
  STALLED_AFTER_DAYS,
} from "@/components/correction/correction-admin-overview";
import type {
  CorrectionAdminOverview,
  OverviewItem,
} from "@/components/correction/correction-types";
import { fetchJson } from "@/lib/api/fetch-json";

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
const NOW = Date.parse("2026-11-24T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const zero = { needs_attention: 0, done: 0, needs_second_approval: 0, not_reviewed: 0 };

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
      sessionOrdinal: 1,
      sessionCount: 1,
      durationSeconds: 3600,
    },
    workspaceId: `ws-${hash}`,
    progress: {
      spanCount: 100,
      totalSeconds: 3600,
      counts: { ...zero, done: 40, needs_second_approval: 10, not_reviewed: 50 },
      seconds: { ...zero, done: 1440, needs_second_approval: 360, not_reviewed: 1800 },
    },
    mine: { approved: 0, disapproved: 0, waitingOnOthers: 0, open: 0 },
    touchedByMe: false,
    lastActivity: { at: daysAgo(1), actorName: "Jana" },
    myLastActivityAt: null,
    changedSinceReaderPublication: 0,
    publication: { inFlight: null },
    ...overrides,
  };
}

function notStarted(hash: string, recording: Partial<OverviewItem["recording"]> = {}): OverviewItem {
  const base = item(hash);
  return {
    ...base,
    work: "not_started",
    recording: { ...base.recording, ...recording },
    workspaceId: null,
    progress: null,
    mine: null,
    lastActivity: null,
    publication: null,
  };
}

function session(hash: string, ordinal: number, overrides: Partial<OverviewItem> = {}): OverviewItem {
  const base = item(hash, overrides);
  return { ...base, recording: { ...base.recording, eventId: ordinal, sessionOrdinal: ordinal, sessionCount: 2 } };
}

describe("groupRecordings", () => {
  it("joins the sessions of one day and place, counting an unstarted one as left", () => {
    const groups = groupRecordings([
      session("b", 2),
      { ...notStarted("a"), recording: { ...session("a", 1).recording } },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((entry) => entry.recording.sessionOrdinal)).toEqual([1, 2]);
    expect(groups[0].totalSeconds).toBe(7200);
    expect(groups[0].seconds.done).toBe(1440);
    expect(groups[0].seconds.not_reviewed).toBe(1800 + 3600);
  });

  it("leaves out a day nobody has started and lists the most recently active first", () => {
    const older = item("old", { lastActivity: { at: daysAgo(9), actorName: "Petr" } });
    older.recording = { ...older.recording, dateDay: 15 };
    const untouched = notStarted("new", { dateDay: 16 });

    const groups = groupRecordings([older, item("recent"), untouched]);

    expect(groups.map((group) => group.items[0].recording.audioHash.slice(0, 6))).toEqual([
      "recent",
      "old000",
    ]);
  });

  it("keeps recordings without a visible event apart", () => {
    const a = item("a");
    const b = item("b");
    a.recording = { ...a.recording, eventId: null };
    b.recording = { ...b.recording, eventId: null };

    expect(groupRecordings([a, b])).toHaveLength(2);
  });
});

describe("deriveNeedsAction", () => {
  const person = (name: string, waitingSeconds = 0) => ({ name, lastActivityAt: daysAgo(1), waitingSeconds });

  it("orders the second pass by audio waiting and calls out a single corrector", () => {
    const small = item("small");
    const large = item("large", {
      progress: { ...item("x").progress!, seconds: { ...zero, needs_second_approval: 3000, done: 600 } },
    });
    const none = item("none", {
      progress: { ...item("x").progress!, seconds: { ...zero, done: 3600 } },
    });

    const action = deriveNeedsAction(
      [small, large, none],
      { "ws-small": [person("Jana", 360)], "ws-large": [person("Jana", 3000), person("Petr")], "ws-none": [person("Jana")] },
      NOW
    );

    expect(action.secondPass).toEqual([large, small]);
    expect(action.soleCorrector).toEqual([small]);
  });

  it("separates ready, changed since publishing and stalled", () => {
    const ready = item("ready", { work: "done" });
    const stale = item("stale", { reader: "stale", changedSinceReaderPublication: 2 });
    const stalled = item("stalled", {
      lastActivity: { at: daysAgo(STALLED_AFTER_DAYS + 1), actorName: "Petr" },
    });
    const finishedLongAgo = item("finished", {
      work: "done",
      reader: "current",
      lastActivity: { at: daysAgo(90), actorName: "Petr" },
    });

    const action = deriveNeedsAction([ready, stale, stalled, finishedLongAgo], {}, NOW);

    expect(action.ready).toEqual([ready]);
    expect(action.stale).toEqual([stale]);
    expect(action.stalled).toEqual([stalled]);
  });
});

describe("CorrectionAdminOverviewPage", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
  });

  function response(): CorrectionAdminOverview {
    const first = session("a", 1);
    const second = session("b", 2);
    const tab = { count: 0, seconds: 0 };
    return {
      catalogId: CATALOG_ID,
      summary: {
        byTab: {
          mine: tab,
          in_progress: { count: 2, seconds: 7200 },
          to_publish: tab,
          published: tab,
          not_started: { count: 3, seconds: 10800 },
        },
      },
      workspaces: [first, second],
      notStarted: { total: 3, items: [] },
      people: [
        {
          name: "Jana",
          lastActivityAt: daysAgo(1),
          lastAudioHash: first.recording.audioHash,
          approvedSeconds7d: 1800,
          approvedSeconds30d: 5400,
          waitingSeconds: 720,
          disputedCount: 2,
        },
        {
          name: null,
          lastActivityAt: daysAgo(40),
          lastAudioHash: second.recording.audioHash,
          approvedSeconds7d: 0,
          approvedSeconds30d: 0,
          waitingSeconds: 0,
          disputedCount: 0,
        },
      ],
      contributors: {
        "ws-a": [{ name: "Jana", lastActivityAt: daysAgo(1), waitingSeconds: 360 }],
        "ws-b": [
          { name: "Jana", lastActivityAt: daysAgo(2), waitingSeconds: 360 },
          { name: null, lastActivityAt: daysAgo(40), waitingSeconds: 0 },
        ],
      },
      disputes: {
        total: 1,
        items: [
          {
            audioHash: second.recording.audioHash,
            spanId: "span-1",
            startSeconds: 842,
            since: daysAgo(5),
            objectorNames: ["Petr"],
          },
        ],
      },
    };
  }

  async function renderPage() {
    fetchJsonMock.mockResolvedValue(response());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CorrectionAdminOverviewPage catalogId={CATALOG_ID} />
      </QueryClientProvider>
    );
    await screen.findByTestId("correction-admin-summary");
  }

  it("shows a day's sessions under one row that opens to its recordings", async () => {
    await renderPage();

    expect(screen.getAllByTestId("correction-admin-group")).toHaveLength(1);
    expect(screen.queryByTestId("correction-admin-recording")).toBeNull();

    await userEvent.click(screen.getByRole("button", { expanded: false }));

    const recordings = screen.getAllByTestId("correction-admin-recording");
    expect(recordings).toHaveLength(2);
    // Only one person has worked on the first session, so its first pass
    // cannot be completed yet.
    expect(within(recordings[0]).getByText("soleCorrector")).toBeInTheDocument();
    expect(within(recordings[1]).queryByText("soleCorrector")).toBeNull();
    expect(within(recordings[1]).getByText("Jana, unknownActor")).toBeInTheDocument();
  });

  it("lists each person with their pace and what waits on others", async () => {
    await renderPage();

    const people = screen.getAllByTestId("correction-admin-person");
    expect(people).toHaveLength(2);
    expect(within(people[0]).getByText("Jana")).toBeInTheDocument();
    expect(within(people[0]).getByText("30 min")).toBeInTheDocument();
    expect(within(people[0]).getByText("1 h 30 min")).toBeInTheDocument();
    expect(within(people[0]).getByText("12 min")).toBeInTheDocument();
    expect(within(people[1]).getByText("unknownActor")).toBeInTheDocument();
  });

  it("links a dispute to its segment and counts the recordings not started", async () => {
    await renderPage();

    const dispute = screen.getByRole("link", { name: /14:02/ });
    expect(dispute).toHaveAttribute(
      "href",
      `/catalog/${CATALOG_ID}/recording/${"b".padEnd(64, "0")}/correction?segment=span-1`
    );
    expect(screen.getByTestId("correction-admin-sole")).toHaveTextContent('{"count":1}');
    expect(screen.getByText(/events\.notStarted .*"count":3/)).toBeInTheDocument();
  });
});
