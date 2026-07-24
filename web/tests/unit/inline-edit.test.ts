import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useInlineEdit } from "@/components/catalog/inline-edit/use-inline-edit";

const catalogId = "20251225_120000";

describe("useInlineEdit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts with empty state", () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    expect(result.current.isEditMode).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(result.current.modifiedCount).toBe(0);
  });

  it("toggles edit mode and shows unsaved dialog when changes exist", () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
    });
    expect(result.current.isEditMode).toBe(true);

    act(() => {
      result.current.updateField("hash-1", "title", "New title");
    });
    expect(result.current.hasUnsavedChanges).toBe(true);

    act(() => {
      result.current.toggleEditMode();
    });

    expect(result.current.isEditMode).toBe(true);
    expect(result.current.showUnsavedDialog).toBe(true);
  });

  it("can discard changes via confirmDiscard", () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    // Must use separate act() blocks so hook sees intermediate state updates
    act(() => {
      result.current.toggleEditMode();
    });
    act(() => {
      result.current.updateField("hash-1", "artist", "Artist A");
    });
    act(() => {
      result.current.toggleEditMode(); // triggers unsaved dialog
    });

    expect(result.current.showUnsavedDialog).toBe(true);

    act(() => {
      result.current.confirmDiscard();
    });

    expect(result.current.showUnsavedDialog).toBe(false);
    expect(result.current.isEditMode).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("saves changes and reports per-row results", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "Bad request" }),
      } as Response);

    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
      result.current.updateField("hash-1", "title", "Title 1");
      result.current.updateField("hash-2", "verified", true);
    });

    let saveResults: Awaited<ReturnType<typeof result.current.saveAllChanges>> = [];
    await act(async () => {
      saveResults = await result.current.saveAllChanges();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(saveResults).toEqual([
      { hash: "hash-1", success: true },
      { hash: "hash-2", success: false, error: "Bad request" },
    ]);
  });

  it("returns empty results when no changes exist", async () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    let saveResults: Awaited<ReturnType<typeof result.current.saveAllChanges>> = [];
    await act(async () => {
      saveResults = await result.current.saveAllChanges();
    });

    expect(saveResults).toEqual([]);
  });

  it("revertField drops one field but keeps the rest of the row", () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
    });
    act(() => {
      result.current.updateField("hash-1", "title", "New title");
      result.current.updateField("hash-1", "part", 3);
    });
    act(() => {
      result.current.revertField("hash-1", "title");
    });

    expect(result.current.isModified("hash-1", "title")).toBe(false);
    expect(result.current.isModified("hash-1", "part")).toBe(true);
    expect(result.current.isModified("hash-1")).toBe(true);
  });

  it("revertField removes the row when the last field is reverted", () => {
    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
    });
    act(() => {
      result.current.updateField("hash-1", "title", "New title");
    });
    act(() => {
      result.current.revertField("hash-1", "title");
    });

    expect(result.current.isModified("hash-1")).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(result.current.modifiedCount).toBe(0);
  });

  it("revertField clears a stale save error once the row is clean (CRITICAL #4)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Bad request" }),
    } as Response);

    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
    });
    act(() => {
      result.current.updateField("hash-1", "title", "New title");
    });
    await act(async () => {
      await result.current.saveAllChanges();
    });

    // Save failed → error shown and the row is still marked modified.
    expect(result.current.saveErrors.get("hash-1")).toBe("Bad request");
    expect(result.current.isModified("hash-1")).toBe(true);

    // Reverting the only changed field clears the error and un-marks the row.
    act(() => {
      result.current.revertField("hash-1", "title");
    });

    expect(result.current.saveErrors.has("hash-1")).toBe(false);
    expect(result.current.isModified("hash-1")).toBe(false);
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("revertField keeps the save error while other fields are still changed", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Bad request" }),
    } as Response);

    const { result } = renderHook(() => useInlineEdit({ catalogId }));

    act(() => {
      result.current.toggleEditMode();
    });
    act(() => {
      result.current.updateField("hash-1", "title", "New title");
      result.current.updateField("hash-1", "part", 3);
    });
    await act(async () => {
      await result.current.saveAllChanges();
    });

    expect(result.current.saveErrors.get("hash-1")).toBe("Bad request");

    // Revert only one of two changed fields — the row is still modified,
    // so the error must remain visible.
    act(() => {
      result.current.revertField("hash-1", "title");
    });

    expect(result.current.saveErrors.get("hash-1")).toBe("Bad request");
    expect(result.current.isModified("hash-1", "title")).toBe(false);
    expect(result.current.isModified("hash-1", "part")).toBe(true);
  });
});
