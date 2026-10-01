import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadsContent } from "@/components/offline/downloads-content";
import type { DownloadRecord } from "@/lib/offline/downloads-db";

const HASH = "a".repeat(64);
const redownload = vi.fn();
const upgrade = vi.fn(() => false);

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/hooks/use-install-prompt", () => ({ useInstallPrompt: () => ({ isInstalled: true }) }));
vi.mock("@/hooks/use-aac-upgrade-available", () => ({ useAacUpgradeAvailable: () => upgrade() }));
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
  useDownloadManager: () => ({ records: [record], supported: true, hydrated: true, storage: null, activeKey: null }),
}));
vi.mock("@/lib/offline/download-manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/download-manager")>()),
  downloadManager: { redownload: (key: string) => redownload(key), remove: vi.fn(), pause: vi.fn(), resume: vi.fn() },
}));

describe("DownloadsContent", () => {
  beforeEach(() => {
    redownload.mockReset();
    upgrade.mockReturnValue(false);
  });

  it("offers a new download for a WebM package that has an AAC copy", () => {
    upgrade.mockReturnValue(true);
    render(<DownloadsContent />);

    expect(screen.getByTestId(`download-format-upgrade-${HASH}`)).toHaveTextContent("formatUpgrade");
    fireEvent.click(screen.getByTestId(`download-redownload-${HASH}`));
    expect(redownload).toHaveBeenCalledWith(`cat:${HASH}`);
  });

  it("shows neither the notice nor the button otherwise", () => {
    render(<DownloadsContent />);

    expect(screen.queryByTestId(`download-format-upgrade-${HASH}`)).toBeNull();
    expect(screen.queryByTestId(`download-redownload-${HASH}`)).toBeNull();
  });
});
