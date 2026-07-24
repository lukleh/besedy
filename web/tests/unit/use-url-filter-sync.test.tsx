import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useUrlFilterSync } from "@/components/catalog/catalog-list/hooks/use-url-filter-sync";

describe("useUrlFilterSync", () => {
  it("applies URL-seeded filters through the wrapped setters", async () => {
    const setRecorderFilter = vi.fn();
    const setLocationFilter = vi.fn();
    const setAlbumFilter = vi.fn();

    const { result } = renderHook(() =>
      useUrlFilterSync({
        searchKey: "recorder=5&location=7&album=9",
        filtersReady: true,
        setRecorderFilter,
        setLocationFilter,
        setAlbumFilter,
      })
    );

    await waitFor(() => {
      expect(setRecorderFilter).toHaveBeenCalledWith("5");
      expect(setLocationFilter).toHaveBeenCalledWith("7");
      expect(setAlbumFilter).toHaveBeenCalledWith("9");
      expect(result.current.urlFilterValuesRef.current).toEqual({
        recorder: "5",
        location: "7",
        album: "9",
      });
    });
  });

  it("does not reapply the same URL filters on rerender", async () => {
    const setRecorderFilter = vi.fn();
    const setLocationFilter = vi.fn();
    const setAlbumFilter = vi.fn();

    const { rerender } = renderHook(
      ({ searchKey }) =>
        useUrlFilterSync({
          searchKey,
          filtersReady: true,
          setRecorderFilter,
          setLocationFilter,
          setAlbumFilter,
        }),
      {
        initialProps: { searchKey: "recorder=5" },
      }
    );

    await waitFor(() => {
      expect(setRecorderFilter).toHaveBeenCalledTimes(1);
      expect(setRecorderFilter).toHaveBeenCalledWith("5");
    });

    rerender({ searchKey: "recorder=5" });

    await waitFor(() => {
      expect(setRecorderFilter).toHaveBeenCalledTimes(1);
      expect(setLocationFilter).not.toHaveBeenCalled();
      expect(setAlbumFilter).not.toHaveBeenCalled();
    });
  });
});
