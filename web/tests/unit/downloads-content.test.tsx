import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DownloadsContent,
  recordPageUrl,
  sortDownloadRecords,
} from "@/components/offline/downloads-content";
import type { DownloadRecord } from "@/lib/offline/downloads-db";

const HASH = "a".repeat(64);
const mocks = vi.hoisted(() => ({ locale: "en", records: null as DownloadRecord[] | null }));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => mocks.locale,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/use-install-prompt", () => ({ useInstallPrompt: () => ({ isInstalled: true }) }));
const record: DownloadRecord = {
  key: `cat:${HASH}`,
  catalogId: "cat",
  catalogLabel: "Catalog",
  hash: HASH,
  userId: "u1",
  eventKey: null,
  event: null,
  recording: { title: "Talk", artist: null, durationHms: "03:59:05", recorderName: null, dateYear: null, dateMonth: null, dateDay: null },
  audioUrl: `/api/catalogs/cat/recordings/${HASH}/audio`,
  audioCacheKey: null,
  status: "complete",
  progress: 100,
  bytesLoaded: 10,
  totalBytes: 10,
  error: null,
  resumeOnReconnect: false,
  transcriptBackend: null,
  hasArtwork: false,
  createdAt: 0,
  updatedAt: 0,
  completedAt: 0,
};
vi.mock("@/hooks/use-downloads", () => ({
  useDownloadManager: () => ({
    records: mocks.records ?? [record],
    supported: true,
    hydrated: true,
    storage: null,
    activeKey: null,
  }),
}));
vi.mock("@/lib/offline/download-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/download-manager")>()),
  downloadManager: { remove: vi.fn(), pause: vi.fn(), resume: vi.fn() },
}));

describe("DownloadsContent", () => {
  beforeEach(() => {
    mocks.locale = "en";
    mocks.records = null;
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  });

  it("titles an event with the date form of the catalog list", () => {
    mocks.locale = "cs";
    mocks.records = [eventRecord("b", { dateYear: 2026, dateMonth: 1, dateDay: 10 })];
    render(<DownloadsContent />);

    expect(screen.getByText("10. Ledna 2026 · Prague")).toBeInTheDocument();
  });

  it("shows listening progress saved on this device", () => {
    window.localStorage.setItem(`besedy-playback-${HASH}`, "5400");
    window.localStorage.setItem(`besedy-playback-completed-${"b".repeat(64)}`, "true");
    mocks.records = [record, eventRecord("b", { dateYear: 2026, dateMonth: 1, dateDay: 10 })];
    render(<DownloadsContent />);

    expect(screen.getByLabelText("percentListened")).toHaveTextContent("38%");
    expect(screen.getByLabelText("listened")).toBeInTheDocument();
  });


});

function eventRecord(
  hashChar: string,
  date: { dateYear: number; dateMonth: number | null; dateDay: number | null },
  overrides: Partial<DownloadRecord> = {},
): DownloadRecord {
  const hash = hashChar.repeat(64);
  return {
    ...record,
    key: `cat:${hash}`,
    hash,
    eventKey: "cat:7",
    event: {
      id: 7,
      title: "Evening talk",
      locationName: "Prague",
      ...date,
      sessionIndex: 1,
      sessionOrdinal: 1,
      sessionCount: 1,
      publishedArtwork: null,
    },
    ...overrides,
  };
}

describe("sortDownloadRecords", () => {
  it("puts the newest event first, as the catalog list does", () => {
    const sorted = sortDownloadRecords([
      eventRecord("b", { dateYear: 2025, dateMonth: 3, dateDay: 1 }, { createdAt: 9 }),
      { ...record, createdAt: 5 },
      eventRecord("c", { dateYear: 2026, dateMonth: null, dateDay: null }),
      eventRecord("d", { dateYear: 2026, dateMonth: 2, dateDay: 4 }),
      { ...record, key: "cat:e", hash: "e".repeat(64), createdAt: 8 },
    ]);

    expect(sorted.map((item) => item.hash[0])).toEqual(["d", "c", "b", "e", "a"]);
  });

  it("orders sessions of one day by their index", () => {
    const first = eventRecord("b", { dateYear: 2026, dateMonth: 2, dateDay: 4 });
    const second = eventRecord("c", { dateYear: 2026, dateMonth: 2, dateDay: 4 });
    second.event = { ...second.event!, sessionIndex: 2 };

    expect(sortDownloadRecords([first, second]).map((item) => item.hash[0])).toEqual(["c", "b"]);
  });
});

describe("recordPageUrl", () => {
  it("opens the recording page, which leads back to Downloads", () => {
    expect(recordPageUrl(record)).toBe(`/catalog/cat/recording/${HASH}?backTo=%2Fdownloads`);
  });

  it("opens the event page for an event download, which leads back to Downloads", () => {
    expect(recordPageUrl({ ...record, eventKey: "cat:7" })).toBe(
      "/catalog/cat/event/7?backTo=%2Fdownloads",
    );
  });
});
