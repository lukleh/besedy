import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/providers";

const { useLabsSyncListener } = vi.hoisted(() => ({
  useLabsSyncListener: vi.fn(),
}));

const { downloadManagerBridge, serviceWorkerProvider } = vi.hoisted(() => ({
  downloadManagerBridge: vi.fn(),
  serviceWorkerProvider: vi.fn(),
}));

vi.mock("@/hooks/use-labs", () => ({
  useLabsSyncListener,
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/contexts/text-size-context", () => ({
  TextSizeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/contexts/radio-mode-context", () => ({
  RadioModeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/contexts/audio-playback-context", () => ({
  AudioPlaybackProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/contexts/service-worker-context", () => ({
  ServiceWorkerProvider: ({ children, passive }: { children: ReactNode; passive?: boolean }) => {
    serviceWorkerProvider({ passive });
    return <>{children}</>;
  },
}));

vi.mock("@/components/offline/download-manager-bridge", () => ({
  DownloadManagerBridge: () => {
    downloadManagerBridge();
    return null;
  },
}));

describe("Providers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/catalog");
  });

  it("mounts global labs sync listener", () => {
    render(
      <Providers>
        <div data-testid="content">content</div>
      </Providers>
    );

    expect(useLabsSyncListener).toHaveBeenCalledTimes(1);
    expect(downloadManagerBridge).toHaveBeenCalledTimes(1);
    expect(serviceWorkerProvider).toHaveBeenCalledWith({ passive: false });
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("keeps the Downloads warm-up frame passive", () => {
    window.history.replaceState({}, "", "/downloads?warm=1");

    render(
      <Providers>
        <div data-testid="content">content</div>
      </Providers>
    );

    expect(downloadManagerBridge).not.toHaveBeenCalled();
    expect(serviceWorkerProvider).toHaveBeenCalledWith({ passive: true });
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });

  it("activates the cached Downloads shell when it is opened normally", () => {
    window.history.replaceState({}, "", "/downloads");

    render(
      <Providers>
        <div>content</div>
      </Providers>
    );

    expect(downloadManagerBridge).toHaveBeenCalledTimes(1);
    expect(serviceWorkerProvider).toHaveBeenCalledWith({ passive: false });
  });
});
