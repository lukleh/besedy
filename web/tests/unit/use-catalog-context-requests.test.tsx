import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCatalogContext } from "@/hooks/use-catalog-context";

describe("archive navigation requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the archive without reading or writing catalog preferences", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify({ id: "bound", label: "Besedy" }), {
        headers: { "Content-Type": "application/json" },
      });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, rerender, unmount } = renderHook(
      ({ catalogId }) => useCatalogContext(catalogId),
      { wrapper, initialProps: { catalogId: "bound" } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ catalogId: "other" });
    expect(result.current.catalogNotFound).toBe(true);
    expect(requests).toEqual(["GET /api/archive"]);
    unmount();
    client.clear();
  });
});
