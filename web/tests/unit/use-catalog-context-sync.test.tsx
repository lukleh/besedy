import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/query/profiles";

// Exercises the real preferences query and active-group mutation, so a sync
// effect that re-fires whenever a failed save settles shows up as a request
// count, not only as a mocked call.

const CATALOG_ID = "20251222_144441";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      ...QUERY_CLIENT_DEFAULT_OPTIONS,
      queries: { ...QUERY_CLIENT_DEFAULT_OPTIONS.queries, retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

// A network failure that takes a moment, like a real offline fetch, so the
// mutation is observed as pending before it fails.
async function networkFailure(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  throw new TypeError("Failed to fetch");
}

function stubFetch(handler: (method: string, url: string) => Promise<Response>) {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push(`${method} ${url}`);
      return handler(method, url);
    })
  );
  return requests;
}

function countOf(requests: string[], request: string): number {
  return requests.filter((entry) => entry === request).length;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("useCatalogContext active-group sync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a failing active-group save once instead of looping", async () => {
    const requests = stubFetch(async (method, url) => {
      if (method === "GET" && url === "/api/preferences") {
        return jsonResponse({
          userId: "user-1",
          activeGroupId: "other-catalog",
          activeGroup: null,
          theme: "system",
          catalogColumns: [],
          settings: {},
        });
      }
      return networkFailure();
    });

    renderHook(() => useCatalogContext(CATALOG_ID, { skipCatalogValidation: true }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(countOf(requests, "PATCH /api/preferences")).toBe(1));
    await settle();

    expect(countOf(requests, "PATCH /api/preferences")).toBe(1);
  });

  it("does not save the active group while preferences cannot load", async () => {
    const requests = stubFetch(() => networkFailure());

    renderHook(() => useCatalogContext(CATALOG_ID, { skipCatalogValidation: true }), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(countOf(requests, "GET /api/preferences")).toBe(1));
    await settle();

    expect(countOf(requests, "PATCH /api/preferences")).toBe(0);
  });
});
