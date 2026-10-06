import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Mic } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnumCrudPage } from "@/components/settings/enum-crud-page";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api/fetch-json", () => ({
  fetchJson: vi.fn(),
}));

const item = {
  id: 7,
  name: "Recorder One",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  _count: { audioMetadata: 0 },
};

function Page({ catalogId }: { catalogId: string }) {
  return (
    <EnumCrudPage
      catalogId={catalogId}
      config={{
        entityName: "recorder",
        resource: "recorders",
        icon: Mic,
        queryKey: ["metadata", "recorders"],
      }}
    />
  );
}

function renderPage(catalogId = "catalog-a") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Page catalogId={catalogId} />
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

describe("EnumCrudPage catalog scoping", () => {
  const fetchJsonMock = vi.mocked(fetchJson);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchJsonMock.mockImplementation(async (_path, init) =>
      init?.method ? ({} as never) : ([item] as never)
    );
  });

  it("keeps reads cached separately when the catalog in the path changes", async () => {
    const view = renderPage();

    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/catalogs/catalog-a/metadata/recorders"
      )
    );

    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <Page catalogId="catalog-b" />
      </QueryClientProvider>
    );
    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/catalogs/catalog-b/metadata/recorders"
      )
    );
  });

  it("sends create, update, and delete to the catalog in the path", async () => {
    renderPage();
    await screen.findByText("Recorder One");

    fireEvent.change(screen.getByPlaceholderText("newRecorderPlaceholder"), {
      target: { value: "Recorder Two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/catalogs/catalog-a/metadata/recorders",
        expect.objectContaining({ method: "POST" })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "edit" }));
    fireEvent.change(screen.getByDisplayValue("Recorder One"), {
      target: { value: "Recorder Updated" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/catalogs/catalog-a/metadata/recorders/7",
        expect.objectContaining({ method: "PUT" })
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "delete" }));
    const deleteButtons = screen.getAllByRole("button", { name: "delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    await waitFor(() =>
      expect(fetchJsonMock).toHaveBeenCalledWith(
        "/api/catalogs/catalog-a/metadata/recorders/7",
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });
});
