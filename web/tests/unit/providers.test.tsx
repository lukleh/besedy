import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/providers";

const { useLabsSyncListener } = vi.hoisted(() => ({
  useLabsSyncListener: vi.fn(),
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
  ServiceWorkerProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("Providers", () => {
  beforeEach(() => {
    useLabsSyncListener.mockClear();
  });

  it("mounts global labs sync listener", () => {
    render(
      <Providers>
        <div data-testid="content">content</div>
      </Providers>
    );

    expect(useLabsSyncListener).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("content")).toBeInTheDocument();
  });
});
