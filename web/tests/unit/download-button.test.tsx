import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadButton } from "@/components/offline/download-button";
import type { DownloadRecord } from "@/lib/offline/download-manager";

const mocks = vi.hoisted(() => ({
  enqueueEvent: vi.fn(),
  useDownloadManager: vi.fn(),
  useDownloadRecord: vi.fn(),
  useEventDownload: vi.fn(),
}));

vi.mock("@/hooks/use-downloads", () => ({
  useDownloadManager: mocks.useDownloadManager,
  useDownloadRecord: mocks.useDownloadRecord,
  useEventDownload: mocks.useEventDownload,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/hooks/use-catalogs", () => ({
  useCatalogs: () => ({
    data: [{ id: "catalog-1", label: "Main catalog" }],
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/offline/download-manager", () => {
  return {
    downloadManager: {
      enqueueEvent: mocks.enqueueEvent,
      enqueueRecording: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    },
  };
});

const completeRecord = {
  status: "complete",
  progress: 100,
  transcriptBackend: "whisperx",
} as DownloadRecord;

describe("DownloadButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useDownloadManager.mockReturnValue({
      supported: true,
      hydrated: true,
    });
    mocks.useDownloadRecord.mockReturnValue(null);
    mocks.useEventDownload.mockReturnValue(null);
    mocks.enqueueEvent.mockResolvedValue(undefined);
  });

  it("keeps the download arrow visible for completed catalog items", () => {
    mocks.useDownloadRecord.mockReturnValue(completeRecord);

    render(<DownloadButton catalogId="catalog-1" hash="recording-hash" />);

    const button = screen.getByRole("button", {
      name: "downloadedWithTranscript",
    });
    expect(button).toHaveAttribute("data-status", "complete");
    expect(button.querySelector(".lucide-download")).toBeInTheDocument();
  });

  it("associates player downloads with their event and selected recording", async () => {
    render(
      <DownloadButton
        catalogId="catalog-1"
        eventId={42}
        hash="recording-hash"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "downloadEvent" })
    );

    await waitFor(() =>
      expect(mocks.enqueueEvent).toHaveBeenCalledWith({
        catalogId: "catalog-1",
        catalogLabel: "Main catalog",
        eventId: 42,
        hash: "recording-hash",
      })
    );
  });
});
