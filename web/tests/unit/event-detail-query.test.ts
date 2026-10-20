import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { eventDetailQueryOptions } from "@/components/catalog/event-detail-query";
import { fetchJson } from "@/lib/api/fetch-json";

vi.mock("@/lib/api/fetch-json", () => ({ fetchJson: vi.fn() }));
vi.mock("@/lib/offline/local-source", () => ({
  readLocalEventDetail: vi.fn(),
  withLocalFallback: (network: () => Promise<unknown>) => network(),
}));

describe("catalog-scoped event detail cache", () => {
  it("does not reuse another catalog's fresh response for the same event id", async () => {
    const client = new QueryClient();
    vi.mocked(fetchJson).mockImplementation(async (url) => ({ url }));
    try {
      await client.fetchQuery({ ...eventDetailQueryOptions("first", 7), staleTime: Infinity });
      const result = await client.fetchQuery({ ...eventDetailQueryOptions("second", 7), staleTime: Infinity });
      expect(result).toEqual({ url: "/api/catalogs/second/events/7" });
    } finally {
      client.clear();
    }
  });

  it("invalidates an event in only the requested catalog", async () => {
    const client = new QueryClient();
    const first = eventDetailQueryOptions("first", 7).queryKey;
    const second = eventDetailQueryOptions("second", 7).queryKey;
    try {
      client.setQueryData(first, { id: 7 });
      client.setQueryData(second, { id: 7 });
      await client.invalidateQueries({ queryKey: first });
      expect(client.getQueryState(first)?.isInvalidated).toBe(true);
      expect(client.getQueryState(second)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});
