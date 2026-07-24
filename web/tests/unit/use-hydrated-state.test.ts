import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useHydratedState, useHydratedBoolean } from "@/hooks/use-hydrated-state";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
    _getStore: () => store,
  };
})();

describe("useHydratedState", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("initialization", () => {
    it("returns default value initially", () => {
      const { result } = renderHook(() =>
        useHydratedState("test-key", "default-value")
      );

      expect(result.current[0]).toBe("default-value");
    });

    it("returns isHydrated as true after effects run", async () => {
      const { result } = renderHook(() =>
        useHydratedState("test-key", "default")
      );

      // In test environment, effects run synchronously
      // The important thing is that hydration eventually completes
      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });
    });

    it("sets isHydrated to true after mount", async () => {
      const { result } = renderHook(() =>
        useHydratedState("test-key", "default")
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });
    });
  });

  describe("localStorage loading", () => {
    it("loads value from localStorage after hydration", async () => {
      localStorageMock.setItem("test-key", JSON.stringify("stored-value"));

      const { result } = renderHook(() =>
        useHydratedState("test-key", "default")
      );

      // Wait for hydration and localStorage load
      await waitFor(() => {
        expect(result.current[0]).toBe("stored-value");
      });
    });

    it("keeps default value when localStorage is empty", async () => {
      const { result } = renderHook(() =>
        useHydratedState("empty-key", "default")
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      expect(result.current[0]).toBe("default");
    });

    it("handles JSON parse errors gracefully", async () => {
      localStorageMock.setItem("bad-json", "not valid json {");

      const { result } = renderHook(() =>
        useHydratedState("bad-json", "fallback")
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      // Should keep default on parse error
      expect(result.current[0]).toBe("fallback");
    });
  });

  describe("setter function", () => {
    it("updates state immediately", async () => {
      const { result } = renderHook(() =>
        useHydratedState("test-key", "initial")
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1]("new-value");
      });

      expect(result.current[0]).toBe("new-value");
    });

    it("persists to localStorage", async () => {
      const { result } = renderHook(() =>
        useHydratedState("persist-key", "initial")
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1]("persisted");
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "persist-key",
        JSON.stringify("persisted")
      );
    });
  });

  describe("complex values", () => {
    it("handles object values", async () => {
      const defaultObj = { count: 0, name: "test" };
      const { result } = renderHook(() =>
        useHydratedState("obj-key", defaultObj)
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1]({ count: 5, name: "updated" });
      });

      expect(result.current[0]).toEqual({ count: 5, name: "updated" });
    });

    it("handles array values", async () => {
      const { result } = renderHook(() =>
        useHydratedState<string[]>("array-key", [])
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1](["a", "b", "c"]);
      });

      expect(result.current[0]).toEqual(["a", "b", "c"]);
    });

    it("handles number values", async () => {
      const { result } = renderHook(() =>
        useHydratedState("num-key", 0)
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1](42);
      });

      expect(result.current[0]).toBe(42);
    });
  });

  describe("custom serialize/deserialize", () => {
    it("uses custom serializer", async () => {
      const serialize = vi.fn((v: number) => `custom:${v}`);
      const deserialize = vi.fn((s: string) => parseInt(s.replace("custom:", "")));

      const { result } = renderHook(() =>
        useHydratedState("custom-key", 0, { serialize, deserialize })
      );

      await waitFor(() => {
        expect(result.current[2]).toBe(true);
      });

      act(() => {
        result.current[1](123);
      });

      expect(serialize).toHaveBeenCalledWith(123);
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "custom-key",
        "custom:123"
      );
    });

    it("uses custom deserializer when loading", async () => {
      localStorageMock.setItem("custom-load", "custom:456");

      const serialize = (v: number) => `custom:${v}`;
      const deserialize = (s: string) => parseInt(s.replace("custom:", ""));

      const { result } = renderHook(() =>
        useHydratedState("custom-load", 0, { serialize, deserialize })
      );

      await waitFor(() => {
        expect(result.current[0]).toBe(456);
      });
    });
  });

  describe("key changes", () => {
    it("reloads value when key changes", async () => {
      localStorageMock.setItem("key-a", JSON.stringify("value-a"));
      localStorageMock.setItem("key-b", JSON.stringify("value-b"));

      const { result, rerender } = renderHook(
        ({ key }) => useHydratedState(key, "default"),
        { initialProps: { key: "key-a" } }
      );

      await waitFor(() => {
        expect(result.current[0]).toBe("value-a");
      });

      rerender({ key: "key-b" });

      await waitFor(() => {
        expect(result.current[0]).toBe("value-b");
      });
    });
  });
});

describe("useHydratedBoolean", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageMock);
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles true values", async () => {
    localStorageMock.setItem("bool-key", "true");

    const { result } = renderHook(() =>
      useHydratedBoolean("bool-key", false)
    );

    await waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
  });

  it("handles false values", async () => {
    localStorageMock.setItem("bool-key", "false");

    const { result } = renderHook(() =>
      useHydratedBoolean("bool-key", true)
    );

    await waitFor(() => {
      expect(result.current[0]).toBe(false);
    });
  });

  it("stores boolean as string", async () => {
    const { result } = renderHook(() =>
      useHydratedBoolean("store-bool", false)
    );

    await waitFor(() => {
      expect(result.current[2]).toBe(true);
    });

    act(() => {
      result.current[1](true);
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith("store-bool", "true");
  });

  it("returns default when localStorage is empty", async () => {
    const { result } = renderHook(() =>
      useHydratedBoolean("empty-bool", true)
    );

    await waitFor(() => {
      expect(result.current[2]).toBe(true);
    });

    expect(result.current[0]).toBe(true);
  });
});
