import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsContent } from "@/components/settings/settings-content";
import { fetchJson } from "@/lib/api/fetch-json";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/hooks/use-catalogs", () => ({
  useCatalogs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/lib/api/fetch-json", () => ({
  fetchJson: vi.fn(),
}));

const discovered = {
  id: "20260923_061236",
  label: "Sep 23, 2026",
  archivedCatalogPath: "/data/text/catalogs/audio_catalog_20260923_061236_loudness_archived.csv",
  metadataCatalogPath: "/data/text/catalogs/audio_catalog_20260923_061236.csv",
};

function mockApi(catalogSync: { status: string; error?: string }) {
  vi.mocked(fetchJson).mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/catalogs/discover") {
      return { baseDir: "/data/text", discovered: 1, new: 1, groups: [discovered] };
    }
    if (url === "/api/catalogs" && init?.method === "POST") {
      return { id: discovered.id, catalogSync };
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsContent />
    </QueryClientProvider>,
  );
}

describe("SettingsContent add catalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns when the new catalog's initial sync failed", async () => {
    mockApi({ status: "error", error: "ENOENT: metadata CSV not found" });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: /^add$/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "initialSyncFailedTitle",
        description: expect.stringContaining("ENOENT: metadata CSV not found"),
        variant: "destructive",
      }),
    );
  });

  it("stays quiet when the initial sync succeeded", async () => {
    mockApi({ status: "success" });
    renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(fetchJson).toHaveBeenCalledWith("/api/catalogs", expect.objectContaining({ method: "POST" })),
    );
    expect(toast).not.toHaveBeenCalled();
  });
});
