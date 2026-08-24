"use client";

import { useEffect } from "react";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { render, act, waitFor, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { ServiceWorkerProvider, useServiceWorker } from "@/contexts/service-worker-context";
import { useSession } from "@/contexts/session-context";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  createServiceWorkerRuntime,
  notifyWebVersionObserver,
  registerWebVersionObserver
} from "@/lib/service-worker/runtime";

vi.mock("@/contexts/reload-safety-context", () => ({
  useReloadSafety: () => ({
    automaticBlockerKinds: [],
    manualBlockerKinds: []
  })
}));

vi.mock("@/lib/service-worker/telemetry", () => ({
  createUpdateAttemptId: () => "test-update-attempt",
  reportWebUpdateEvent: vi.fn()
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: vi.fn()
}));

const UPDATE_STATE_STORAGE_KEY = "besedy-sw-update-state";

function StateProbe() {
  const { wasDismissed, updateAvailable } = useServiceWorker();
  return (
    <div
      data-testid="state"
      data-dismissed={String(wasDismissed)}
      data-update={String(updateAvailable)}
    />
  );
}

function CallbackProbe({
  onRender
}: {
  onRender: (callbacks: {
    postMessage: ReturnType<typeof useServiceWorker>["postMessage"];
    subscribe: ReturnType<typeof useServiceWorker>["subscribe"];
    updateAvailable: boolean;
  }) => void;
}) {
  const { postMessage, subscribe, updateAvailable } = useServiceWorker();

  useEffect(() => {
    onRender({ postMessage, subscribe, updateAvailable });
  }, [onRender, postMessage, subscribe, updateAvailable]);

  return null;
}

describe("ServiceWorkerProvider", () => {
  const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(window.localStorage.getItem).mockImplementation(() => null);
    vi.mocked(window.localStorage.setItem).mockImplementation(() => undefined);
    vi.mocked(window.localStorage.removeItem).mockImplementation(() => undefined);
    window.history.replaceState({}, "", "/catalog");
    vi.mocked(usePathname).mockReturnValue("/catalog");
    vi.mocked(useSession).mockReturnValue({
      session: {
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User",
          image: null,
          emailVerified: true
        },
        session: {
          id: "session-1",
          token: "token",
          expiresAt: new Date("2025-01-01T00:00:00.000Z")
        }
      },
      isPending: false,
      refetch: vi.fn()
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    } else {
      // @ts-expect-error - allow deleting for test cleanup
      delete navigator.serviceWorker;
    }
  });

  it("clears persisted update state on controllerchange", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };

    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        listeners.get(event)?.delete(handler);
      })
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    act(() => {
      listeners.get("controllerchange")?.forEach((handler) => handler());
    });

    expect(window.localStorage.removeItem).toHaveBeenCalledWith(UPDATE_STATE_STORAGE_KEY);
  });

  it("restores dismissal for the same web version when its worker is waiting", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-a");
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      })
    );
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => {
      if (key === UPDATE_STATE_STORAGE_KEY) {
        return JSON.stringify({
          version: "web-b",
          dismissed: true,
          deadline: Date.now() + 60_000
        });
      }
      return null;
    });

    render(
      <ServiceWorkerProvider>
        <StateProbe />
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("state").dataset.dismissed).toBe("true");
    });

    expect(window.localStorage.removeItem).not.toHaveBeenCalledWith(UPDATE_STATE_STORAGE_KEY);
  });

  it("clears dismissal when a different web version is detected", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-a");
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-c" })
      })
    );
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => {
      if (key === UPDATE_STATE_STORAGE_KEY) {
        return JSON.stringify({
          version: "web-b",
          dismissed: true,
          deadline: Date.now() + 60_000
        });
      }
      return null;
    });

    render(
      <ServiceWorkerProvider>
        <StateProbe />
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByTestId("state").dataset.dismissed).toBe("false");
    });

    expect(window.localStorage.setItem).toHaveBeenCalledWith(
      UPDATE_STATE_STORAGE_KEY,
      expect.stringContaining('"version":"web-c"')
    );
  });

  it("auto-applies an ignored update after its deadline when hidden", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-a");
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const deadline = Date.now() - 1000;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      })
    );
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => {
      if (key === UPDATE_STATE_STORAGE_KEY) {
        return JSON.stringify({ version: "web-b", dismissed: false, deadline });
      }
      return null;
    });

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(waitingWorker.postMessage).toHaveBeenCalledWith({
        type: "SKIP_WAITING"
      });
    });
  });

  it("uses real version reachability rather than navigator.onLine", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-a");
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true
    });
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      })
    );
    vi.mocked(window.localStorage.getItem).mockImplementation((key: string) => {
      if (key === UPDATE_STATE_STORAGE_KEY) {
        return JSON.stringify({
          version: "web-b",
          dismissed: false,
          deadline: Date.now() - 1000
        });
      }
      return null;
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(waitingWorker.postMessage).toHaveBeenCalledWith({
        type: "SKIP_WAITING"
      });
    });
  });

  it("still detects an update when local storage is unavailable", () => {
    vi.mocked(window.localStorage.getItem).mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.mocked(window.localStorage.setItem).mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    const runtime = createServiceWorkerRuntime({ clientVersion: "web-a" });

    expect(() => runtime.observeWebVersion("web-b")).not.toThrow();
    expect(runtime.getSnapshot().updateAvailable).toBe(true);
    expect(runtime.getSnapshot().wasDismissed).toBe(false);
  });

  it("triggers registration.update() when a new web version is observed", async () => {
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(registrationMock.addEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function)
      );
    });

    act(() => {
      notifyWebVersionObserver("web-a");
    });
    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(1);
    });

    act(() => {
      notifyWebVersionObserver("web-a");
    });
    expect(registrationMock.update).toHaveBeenCalledTimes(1);

    act(() => {
      notifyWebVersionObserver("web-b");
    });
    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(2);
    });
  });

  it("triggers registration.update() via fetchJson X-Web-Version header", async () => {
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "application/json",
        "x-web-version": "deployed-web-version"
      }),
      json: vi.fn().mockResolvedValue({ ok: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(registrationMock.addEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function)
      );
    });

    await fetchJson("/api/some-endpoint");

    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(1);
    });

    // The same web version on a subsequent response must not re-trigger update().
    await fetchJson("/api/some-endpoint");
    expect(registrationMock.update).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown and empty web-version signals", async () => {
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(registrationMock.addEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function)
      );
    });

    act(() => {
      notifyWebVersionObserver("unknown");
      notifyWebVersionObserver("");
      notifyWebVersionObserver(null);
    });

    expect(registrationMock.update).not.toHaveBeenCalled();

    act(() => {
      notifyWebVersionObserver("real-web-version");
    });

    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(1);
    });
  });

  it("advances web-version detection on non-ok responses (500, 401)", async () => {
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers({
          "content-type": "application/json",
          "x-web-version": "web-500"
        }),
        json: vi.fn().mockResolvedValue({ error: "boom" })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers({
          "content-type": "application/json",
          "x-web-version": "web-401"
        }),
        json: vi.fn().mockResolvedValue({ error: "unauthorized" })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(registrationMock.addEventListener).toHaveBeenCalledWith(
        "updatefound",
        expect.any(Function)
      );
    });

    await expect(fetchJson("/api/a")).rejects.toThrow();
    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(1);
    });

    await expect(fetchJson("/api/b", { skipAuthCheck: true })).rejects.toThrow();
    await waitFor(() => {
      expect(registrationMock.update).toHaveBeenCalledTimes(2);
    });
  });

  it("checks /api/version immediately and then hourly in the authenticated app shell", async () => {
    vi.useFakeTimers();
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-a");

    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-a" })
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 304
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(serviceWorkerMock.register).toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/version",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(
      new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get(
        "If-None-Match"
      )
    ).toBe('"web-a"');
    expect(registrationMock.update).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 60);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).get(
        "If-None-Match"
      )
    ).toBe('"web-a"');
    expect(registrationMock.update).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 60);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers).get(
        "If-None-Match"
      )
    ).toBe('"web-a"');
    expect(registrationMock.update).toHaveBeenCalledTimes(1);
  });

  it("offers a direct reload when the server web version changes but no worker installs", async () => {
    const registrationMock = {
      waiting: null,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ webVersion: "web-server" })
    });
    vi.stubGlobal("fetch", fetchMock);
    const reloadPage = vi.fn();
    const runtime = createServiceWorkerRuntime({
      clientVersion: "web-client",
      reloadPage
    });

    const stop = runtime.start();
    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });

    await waitFor(() => {
      expect(runtime.getSnapshot().updateAvailable).toBe(true);
    });
    expect(runtime.getSnapshot().updateReady).toBe(false);
    expect(registrationMock.waiting).toBeNull();
    expect(registrationMock.update).toHaveBeenCalledTimes(1);

    await expect(runtime.applyUpdate()).resolves.toBe(true);
    expect(reloadPage).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does not activate an update while unsaved changes are present", async () => {
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createServiceWorkerRuntime();
    runtime.setReloadSafety({
      automaticBlockerKinds: ["unsaved-changes"],
      manualBlockerKinds: ["unsaved-changes"]
    });
    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });
    const stop = runtime.start();

    await waitFor(() => {
      expect(runtime.getSnapshot().updateReady).toBe(true);
    });
    await expect(runtime.applyUpdate()).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitingWorker.postMessage).not.toHaveBeenCalled();
    expect(runtime.getSnapshot()).toMatchObject({
      applyState: "blocked",
      blockedReasons: ["unsaved-changes"]
    });
    stop();
  });

  it("keeps a waiting worker inactive until /api/version is reachable", async () => {
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createServiceWorkerRuntime();
    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });
    const stop = runtime.start();

    await waitFor(() => {
      expect(runtime.getSnapshot().updateReady).toBe(true);
    });
    await expect(runtime.applyUpdate()).resolves.toBe(false);
    expect(runtime.getSnapshot().applyState).toBe("waiting-for-connection");
    expect(waitingWorker.postMessage).not.toHaveBeenCalled();

    await expect(runtime.applyUpdate()).resolves.toBe(true);
    expect(waitingWorker.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    stop();
  });

  it("defers controllerchange reloads while another tab has unsaved work", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(handler);
      }),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      })
    );
    const reloadPage = vi.fn();
    const runtime = createServiceWorkerRuntime({ reloadPage });
    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });
    const stop = runtime.start();

    await waitFor(() => expect(runtime.getSnapshot().updateReady).toBe(true));
    await expect(runtime.applyUpdate()).resolves.toBe(true);

    runtime.setReloadSafety({
      automaticBlockerKinds: ["unsaved-changes"],
      manualBlockerKinds: ["unsaved-changes"]
    });
    act(() => {
      listeners.get("controllerchange")?.forEach((handler) => handler());
    });
    expect(reloadPage).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().applyState).toBe("blocked");

    runtime.setReloadSafety({ automaticBlockerKinds: [], manualBlockerKinds: [] });
    await waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
    stop();
  });

  it("persists a dismissal made before the target web version is known", async () => {
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    let resolveVersionCheck!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveVersionCheck = resolve;
        })
      )
    );

    const runtime = createServiceWorkerRuntime({ clientVersion: "web-client" });
    const stop = runtime.start();
    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });

    await waitFor(() => {
      expect(runtime.getSnapshot().updateReady).toBe(true);
    });

    runtime.dismissUpdate();
    resolveVersionCheck(
      new Response(JSON.stringify({ webVersion: "web-server" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await waitFor(() => {
      expect(window.localStorage.setItem).toHaveBeenCalledWith(
        UPDATE_STATE_STORAGE_KEY,
        expect.stringContaining('"dismissed":true')
      );
    });

    stop();
  });

  it("detects a newer web version while an earlier update is still pending", async () => {
    const registrationMock = {
      waiting: null,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-c" })
      });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = createServiceWorkerRuntime({ clientVersion: "web-a" });
    const stop = runtime.start();
    runtime.setAppShellMode({
      isAuthenticatedAppShell: true,
      shouldSilentlyActivateWaitingWorker: false
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(runtime.getSnapshot().updateAvailable).toBe(true);
    });
    runtime.dismissUpdate();

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true
    });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(window.localStorage.setItem).toHaveBeenLastCalledWith(
        UPDATE_STATE_STORAGE_KEY,
        expect.stringContaining('"version":"web-c"')
      );
      expect(runtime.getSnapshot().wasDismissed).toBe(false);
    });

    stop();
  });

  it("checks for a new web version when the installed app returns to the foreground", async () => {
    vi.stubEnv("NEXT_PUBLIC_WEB_VERSION", "web-client");

    const registrationMock = {
      waiting: null,
      active: {},
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 304 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ webVersion: "web-server" })
      });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ServiceWorkerProvider>
        <StateProbe />
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("state").dataset.update).toBe("true");
    });
  });

  it("swallows observer errors to protect fetch callers", () => {
    const unregister = registerWebVersionObserver(() => {
      throw new Error("observer boom");
    });

    expect(() => notifyWebVersionObserver("throwing-version")).not.toThrow();

    unregister();
  });

  it("skips version checks on auth pages", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    window.history.replaceState({}, "", "/auth/signin");
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(serviceWorkerMock.register).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 60);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registrationMock.update).not.toHaveBeenCalled();
  });

  it("silently activates a reachable waiting worker on auth pages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    vi.mocked(useSession).mockReturnValue({
      session: null,
      isPending: false,
      refetch: vi.fn()
    });
    window.history.replaceState({}, "", "/auth/signin");
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(waitingWorker.postMessage).toHaveBeenCalledWith({
        type: "SKIP_WAITING"
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(registrationMock.update).toHaveBeenCalledTimes(1);
  });

  it("silently activates a newly found waiting worker on auth pages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ webVersion: "web-b" })
    });
    vi.stubGlobal("fetch", fetchMock);

    let stateChangeHandler: (() => void) | null = null;
    const listeners = new Map<string, Set<() => void>>();
    const installingWorker = {
      state: "installing",
      postMessage: vi.fn(),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "statechange") {
          stateChangeHandler = handler;
        }
      })
    };
    const registrationMock = {
      waiting: null,
      installing: installingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(handler);
      })
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    vi.mocked(useSession).mockReturnValue({
      session: null,
      isPending: false,
      refetch: vi.fn()
    });
    window.history.replaceState({}, "", "/auth/signin");
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    act(() => {
      listeners.get("updatefound")?.forEach((handler) => handler());
      installingWorker.state = "installed";
      stateChangeHandler?.();
    });

    await waitFor(() => {
      expect(installingWorker.postMessage).toHaveBeenCalledWith({
        type: "SKIP_WAITING"
      });
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/version",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("skips version checks when logged out", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    vi.mocked(useSession).mockReturnValue({
      session: null,
      isPending: false,
      refetch: vi.fn()
    });

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <div>child</div>
      </ServiceWorkerProvider>
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(serviceWorkerMock.register).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000 * 60 * 60);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(registrationMock.update).not.toHaveBeenCalled();
  });

  it("does not reload on controllerchange while on auth pages", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const registrationMock = {
      waiting: null,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: {},
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (!listeners.has(event)) {
          listeners.set(event, new Set());
        }
        listeners.get(event)?.add(handler);
      }),
      removeEventListener: vi.fn((event: string, handler: () => void) => {
        listeners.get(event)?.delete(handler);
      })
    };
    const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    vi.mocked(useSession).mockReturnValue({
      session: null,
      isPending: false,
      refetch: vi.fn()
    });
    window.history.replaceState({}, "", "/auth/signin");
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    try {
      render(
        <ServiceWorkerProvider>
          <div>child</div>
        </ServiceWorkerProvider>
      );

      await waitFor(() => {
        expect(serviceWorkerMock.register).toHaveBeenCalled();
      });

      act(() => {
        listeners.get("controllerchange")?.forEach((handler) => handler());
      });

      expect(consoleLogMock).toHaveBeenCalledWith(
        "[SW] New service worker activated outside app shell; skipping reload"
      );
    } finally {
      consoleLogMock.mockRestore();
    }
  });

  it("keeps postMessage and subscribe stable across provider state updates", async () => {
    const waitingWorker = { postMessage: vi.fn() };
    const registrationMock = {
      waiting: waitingWorker,
      active: null,
      update: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn()
    };
    const serviceWorkerMock = {
      controller: null,
      register: vi.fn().mockResolvedValue(registrationMock),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    const renders: Array<{
      postMessage: ReturnType<typeof useServiceWorker>["postMessage"];
      subscribe: ReturnType<typeof useServiceWorker>["subscribe"];
      updateAvailable: boolean;
    }> = [];

    Object.defineProperty(navigator, "serviceWorker", {
      value: serviceWorkerMock,
      configurable: true
    });

    render(
      <ServiceWorkerProvider>
        <CallbackProbe onRender={(callbacks) => renders.push(callbacks)} />
      </ServiceWorkerProvider>
    );

    await waitFor(() => {
      expect(serviceWorkerMock.register).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(renders.some((rendered) => rendered.updateAvailable)).toBe(true);
    });

    const initial = renders[0];
    const afterUpdate = renders.find((rendered) => rendered.updateAvailable);

    expect(initial).toBeDefined();
    expect(afterUpdate).toBeDefined();
    expect(afterUpdate?.postMessage).toBe(initial?.postMessage);
    expect(afterUpdate?.subscribe).toBe(initial?.subscribe);
  });
});
