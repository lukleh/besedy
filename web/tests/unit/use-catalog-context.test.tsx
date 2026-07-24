import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useUpdateActiveGroup } from "@/hooks/use-update-active-group";

vi.mock("@/hooks/use-active-group", () => ({
  useActiveGroup: vi.fn(),
}));

vi.mock("@/hooks/use-catalogs", () => ({
  useCatalogs: vi.fn(),
}));

vi.mock("@/hooks/use-update-active-group", () => ({
  useUpdateActiveGroup: vi.fn(),
}));

describe("useCatalogContext", () => {
  const useActiveGroupMock = vi.mocked(useActiveGroup);
  const useCatalogsMock = vi.mocked(useCatalogs);
  const useUpdateActiveGroupMock = vi.mocked(useUpdateActiveGroup);
  const mutateMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useActiveGroupMock.mockReturnValue({
      activeGroupId: null,
      activeGroup: null,
      groupKey: "default",
      isLoading: false,
    } as ReturnType<typeof useActiveGroup>);
    useUpdateActiveGroupMock.mockReturnValue({
      mutate: mutateMock,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateActiveGroup>);
  });

  it("keeps server-validated pages responsive while background validation runs", () => {
    useCatalogsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as ReturnType<typeof useCatalogs>);

    const { result } = renderHook(() =>
      useCatalogContext("catalog-1", { skipCatalogValidation: true })
    );

    expect(useCatalogsMock).toHaveBeenCalledWith({ enabled: true });
    expect(result.current.catalogValidationLoading).toBe(false);
    expect(result.current.catalogNotFound).toBe(false);
    expect(mutateMock).toHaveBeenCalledWith("catalog-1");
  });

  it("marks a skipped-validation catalog as missing after background revalidation", () => {
    useCatalogsMock
      .mockReturnValueOnce({
        data: undefined,
        isLoading: true,
      } as ReturnType<typeof useCatalogs>)
      .mockReturnValueOnce({
        data: [{ id: "catalog-2", label: "Other" }],
        isLoading: false,
      } as ReturnType<typeof useCatalogs>);

    const { result, rerender } = renderHook(() =>
      useCatalogContext("catalog-1", { skipCatalogValidation: true })
    );

    expect(result.current.catalogNotFound).toBe(false);

    rerender();

    expect(result.current.catalogValidationLoading).toBe(false);
    expect(result.current.catalogNotFound).toBe(true);
  });
});
