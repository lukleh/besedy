import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useArchive } from "@/hooks/use-archive";
import { ApiError } from "@/lib/api/fetch-json";

vi.mock("@/hooks/use-archive", () => ({ useArchive: vi.fn() }));

describe("useCatalogContext", () => {
  const archive = vi.mocked(useArchive);
  beforeEach(() => {
    vi.clearAllMocks();
    archive.mockReturnValue({
      data: { id: "bound", label: "Besedy" },
      error: null,
      isLoading: false,
    } as ReturnType<typeof useArchive>);
  });

  it("rejects a URL for another source without substituting the archive", () => {
    const { result } = renderHook(() => useCatalogContext("other"));
    expect(result.current.catalogId).toBe("other");
    expect(result.current.catalogNotFound).toBe(true);
  });

  it("uses the configured archive label for its matching source URL", () => {
    const { result } = renderHook(() => useCatalogContext("bound"));
    expect(result.current.archive).toEqual({ id: "bound", label: "Besedy" });
    expect(result.current.catalogNotFound).toBe(false);
  });

  it("keeps server-validated pages responsive during background validation", () => {
    archive.mockReturnValue({ data: undefined, isLoading: true, error: null } as ReturnType<typeof useArchive>);
    const { result } = renderHook(() => useCatalogContext("bound", { skipCatalogValidation: true }));
    expect(result.current.catalogValidationLoading).toBe(false);
    expect(result.current.catalogNotFound).toBe(false);
  });

  it("blocks an unvalidated page while the archive is loading", () => {
    archive.mockReturnValue({ data: undefined, isLoading: true, error: null } as ReturnType<typeof useArchive>);
    const { result } = renderHook(() => useCatalogContext("bound"));
    expect(result.current.catalogValidationLoading).toBe(true);
  });

  it("handles revoked access without treating a network outage as revocation", () => {
    archive.mockReturnValue({ data: undefined, isLoading: false, error: new ApiError("Denied", 403) } as unknown as ReturnType<typeof useArchive>);
    const { result, rerender } = renderHook(() => useCatalogContext("bound"));
    expect(result.current.catalogNotFound).toBe(true);
    archive.mockReturnValue({ data: undefined, isLoading: false, error: new TypeError("Offline") } as ReturnType<typeof useArchive>);
    rerender();
    expect(result.current.catalogNotFound).toBe(false);
  });
});
