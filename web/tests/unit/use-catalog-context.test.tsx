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
      isSuccess: true,
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

  it("does not retry a failed sync on the next render", () => {
    useCatalogsMock.mockReturnValue({
      data: [{ id: "catalog-1", label: "One" }],
      isLoading: false,
    } as ReturnType<typeof useCatalogs>);
    const mutation = { mutate: mutateMock, isPending: false };
    useUpdateActiveGroupMock.mockImplementation(
      () => mutation as unknown as ReturnType<typeof useUpdateActiveGroup>
    );

    const { rerender } = renderHook(() =>
      useCatalogContext("catalog-1", { skipCatalogValidation: true })
    );
    expect(mutateMock).toHaveBeenCalledTimes(1);

    // The save starts, then fails; the active group is still not catalog-1.
    mutation.isPending = true;
    rerender();
    mutation.isPending = false;
    rerender();

    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("syncs again when the route moves to another catalog", () => {
    useCatalogsMock.mockReturnValue({
      data: [
        { id: "catalog-1", label: "One" },
        { id: "catalog-2", label: "Two" },
      ],
      isLoading: false,
    } as ReturnType<typeof useCatalogs>);

    const { rerender } = renderHook(
      ({ catalogId }) => useCatalogContext(catalogId, { skipCatalogValidation: true }),
      { initialProps: { catalogId: "catalog-1" } }
    );
    rerender({ catalogId: "catalog-2" });

    expect(mutateMock.mock.calls).toEqual([["catalog-1"], ["catalog-2"]]);
  });

  it("does not sync while the saved preferences could not be loaded", () => {
    useActiveGroupMock.mockReturnValue({
      activeGroupId: null,
      activeGroup: null,
      groupKey: "default",
      isLoading: false,
      isSuccess: false,
    } as ReturnType<typeof useActiveGroup>);
    useCatalogsMock.mockReturnValue({
      data: [{ id: "catalog-1", label: "One" }],
      isLoading: false,
    } as ReturnType<typeof useCatalogs>);

    renderHook(() => useCatalogContext("catalog-1", { skipCatalogValidation: true }));

    expect(mutateMock).not.toHaveBeenCalled();
  });
});
