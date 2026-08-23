"use client";

import type { ClientToSWMessage, SWToClientMessage } from "@/lib/service-worker/messages";
import { createClientLogger } from "@/lib/log/client";

const AUTO_APPLY_SW_UPDATES = true;
const AUTO_APPLY_DELAY_MS = 1000;
const DISMISSED_STORAGE_KEY = "besedy-sw-update-dismissed";
const DISMISSED_UPDATE_DEADLINE_KEY = "besedy-sw-update-dismissed-deadline";
const AUTO_APPLY_DISMISSED_DEADLINE_MS = 1000 * 60 * 60 * 24;
const AUTO_APPLY_DISMISSED_IDLE_MS = 1000 * 60 * 5;
const AUTO_APPLY_DISMISSED_CHECK_INTERVAL_MS = 1000 * 30;
const VERSION_ETAG_CHECK_INTERVAL_MS = 1000 * 60 * 60;
const logger = createClientLogger("SW");

let activeCommitObserver: ((commit: string) => void) | null = null;

export function registerCommitObserver(
  observer: (commit: string) => void
): () => void {
  activeCommitObserver = observer;
  return () => {
    if (activeCommitObserver === observer) {
      activeCommitObserver = null;
    }
  };
}

export function notifyCommitObserver(commit: string | null | undefined): void {
  const observer = activeCommitObserver;
  if (!observer) return;
  if (!commit || commit === "unknown") return;
  try {
    observer(commit);
  } catch {
    // Never let an observer error break the caller (e.g., a fetch).
  }
}

export interface ServiceWorkerRuntimeSnapshot {
  isSupported: boolean;
  isRegistered: boolean;
  isReady: boolean;
  updateAvailable: boolean;
  error: Error | null;
  wasDismissed: boolean;
}

export interface ServiceWorkerRuntimeMode {
  isAuthenticatedAppShell: boolean;
  shouldSilentlyActivateWaitingWorker: boolean;
}

export type ServiceWorkerRuntimeListener = (
  snapshot: ServiceWorkerRuntimeSnapshot
) => void;

export type ServiceWorkerMessageHandler = (message: SWToClientMessage) => void;

interface VersionInfoResponse {
  commit?: string | null;
}

interface ServiceWorkerRuntimeOptions {
  clientCommit?: string;
  reloadPage?: () => void;
}

function normalizeCommit(commit: string | null | undefined): string | null {
  if (!commit || commit === "unknown") return null;
  return commit;
}

function hasServiceWorkerSupport(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

function readDismissedFlag(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(DISMISSED_STORAGE_KEY) === "true";
}

function readDismissedDeadline(): number | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(DISMISSED_UPDATE_DEADLINE_KEY);
  if (!raw) return null;
  const deadline = Number(raw);
  return Number.isFinite(deadline) ? deadline : null;
}

function createInitialSnapshot(): ServiceWorkerRuntimeSnapshot {
  const isSupported = hasServiceWorkerSupport();
  const hasController = isSupported && !!navigator.serviceWorker.controller;

  return {
    isSupported,
    isRegistered: hasController,
    isReady: hasController,
    updateAvailable: false,
    error: null,
    wasDismissed: readDismissedFlag(),
  };
}

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions = {}) {
  const clientCommit = normalizeCommit(
    options.clientCommit ?? process.env.NEXT_PUBLIC_GIT_COMMIT
  );
  const reloadPage = options.reloadPage ?? (() => window.location.reload());
  let snapshot = createInitialSnapshot();
  let mode: ServiceWorkerRuntimeMode = {
    isAuthenticatedAppShell: false,
    shouldSilentlyActivateWaitingWorker: false,
  };
  let isAudioPlaying = false;
  let registration: ServiceWorkerRegistration | null = null;
  let waitingWorker: ServiceWorker | null = null;
  let autoApplyTimeoutId: number | null = null;
  let dismissedWatcherCleanup: (() => void) | null = null;
  let registrationCleanup: (() => void) | null = null;
  let versionCheckTimeoutId: number | null = null;
  let versionCheckAbortController: AbortController | null = null;
  let lastActivity = Date.now();
  let autoApplyDismissed = false;
  let lastVersion: string | null = clientCommit;
  let initialVersionCheckPending = clientCommit !== null;
  let hasServerCommitMismatch = false;
  let wasAudioPlayingOnUpdate = false;

  const listeners = new Set<ServiceWorkerRuntimeListener>();
  const messageHandlers = new Set<ServiceWorkerMessageHandler>();

  function emit() {
    const nextSnapshot = { ...snapshot };
    listeners.forEach((listener) => listener(nextSnapshot));
  }

  function setSnapshot(
    updater:
      | Partial<ServiceWorkerRuntimeSnapshot>
      | ((current: ServiceWorkerRuntimeSnapshot) => ServiceWorkerRuntimeSnapshot)
  ) {
    snapshot =
      typeof updater === "function"
        ? updater(snapshot)
        : { ...snapshot, ...updater };
    emit();
  }

  function clearAutoApplyTimeout() {
    if (autoApplyTimeoutId !== null) {
      window.clearTimeout(autoApplyTimeoutId);
      autoApplyTimeoutId = null;
    }
  }

  function stopVersionCheck() {
    if (versionCheckTimeoutId !== null) {
      window.clearTimeout(versionCheckTimeoutId);
      versionCheckTimeoutId = null;
    }

    versionCheckAbortController?.abort();
    versionCheckAbortController = null;
  }

  function stopDismissedWatcher() {
    dismissedWatcherCleanup?.();
    dismissedWatcherCleanup = null;
  }

  function activateWaitingWorker(): boolean {
    if (!waitingWorker) return false;

    logger.info("Applying update - sending SKIP_WAITING");
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    wasAudioPlayingOnUpdate = false;
    clearAutoApplyTimeout();
    return true;
  }

  function applyAvailableUpdate(): boolean {
    if (!mode.isAuthenticatedAppShell) {
      logger.info("Skipping automatic update activation outside app shell");
      return false;
    }

    if (activateWaitingWorker()) {
      return true;
    }

    if (!snapshot.updateAvailable) {
      return false;
    }

    logger.info("Applying update with a direct page reload");
    wasAudioPlayingOnUpdate = false;
    clearAutoApplyTimeout();
    reloadPage();
    return true;
  }

  function shouldAutoApplyDismissedUpdate(): boolean {
    if (autoApplyDismissed) return false;
    if (!snapshot.updateAvailable || !snapshot.wasDismissed) return false;
    if (isAudioPlaying) return false;

    const deadline = readDismissedDeadline();
    if (!deadline || Date.now() < deadline) return false;

    const idleMs = Date.now() - lastActivity;
    return document.visibilityState === "hidden" || idleMs >= AUTO_APPLY_DISMISSED_IDLE_MS;
  }

  function syncDismissedWatcher() {
    stopDismissedWatcher();

    if (typeof window === "undefined") return;
    if (!mode.isAuthenticatedAppShell) return;
    if (!snapshot.updateAvailable) {
      autoApplyDismissed = false;
      return;
    }
    if (!snapshot.wasDismissed) return;

    const runAutoApply = () => {
      if (!shouldAutoApplyDismissedUpdate()) return;
      if (applyAvailableUpdate()) {
        autoApplyDismissed = true;
      }
    };

    const markActivity = () => {
      lastActivity = Date.now();
    };

    const activityEvents = ["mousemove", "keydown", "touchstart", "scroll"];
    activityEvents.forEach((event) => {
      window.addEventListener(event, markActivity, { passive: true });
    });

    const handleVisibilityChange = () => {
      runAutoApply();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const intervalId = window.setInterval(
      runAutoApply,
      AUTO_APPLY_DISMISSED_CHECK_INTERVAL_MS
    );

    runAutoApply();

    dismissedWatcherCleanup = () => {
      activityEvents.forEach((event) => {
        window.removeEventListener(event, markActivity);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(intervalId);
    };
  }

  function syncDeferredAudioAutoApply() {
    clearAutoApplyTimeout();

    if (!AUTO_APPLY_SW_UPDATES) return;
    if (!snapshot.updateAvailable) return;
    if (!mode.isAuthenticatedAppShell) return;
    if (!wasAudioPlayingOnUpdate) return;

    if (isAudioPlaying) {
      logger.info("Deferring auto-apply while audio is playing");
      return;
    }

    logger.info("Audio stopped, scheduling auto-apply update");
    autoApplyTimeoutId = window.setTimeout(() => {
      logger.info("Auto-applying update (audio stopped)");
      applyAvailableUpdate();
    }, AUTO_APPLY_DELAY_MS);
  }

  function syncSilentActivation() {
    if (!snapshot.updateAvailable) return;
    if (!mode.shouldSilentlyActivateWaitingWorker) return;

    logger.info("Silently activating waiting worker outside app shell");
    activateWaitingWorker();
  }

  function observeCommitUpdate(commit: string | null | undefined) {
    const normalizedCommit = normalizeCommit(commit);
    if (!normalizedCommit) return;
    const previous = lastVersion;
    if (previous === normalizedCommit) return;
    lastVersion = normalizedCommit;

    if (clientCommit && normalizedCommit !== clientCommit) {
      hasServerCommitMismatch = true;
      if (!snapshot.updateAvailable) {
        clearDismissedState();
        setSnapshot((current) => ({ ...current, updateAvailable: true }));
        logger.info("Update available - server commit differs from client build");

        if (AUTO_APPLY_SW_UPDATES && mode.isAuthenticatedAppShell) {
          wasAudioPlayingOnUpdate = isAudioPlaying;
          logger.info("Audio playing on update:", isAudioPlaying);
        }

        refreshAutomation();
      }
    }

    registration?.update().catch(() => {});
  }

  async function runVersionCheck() {
    versionCheckTimeoutId = null;

    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell) return;
    if (snapshot.updateAvailable) return;

    const headers = new Headers();
    if (lastVersion && lastVersion !== "unknown") {
      headers.set("If-None-Match", `"${lastVersion}"`);
    }

    const abortController = new AbortController();
    versionCheckAbortController = abortController;

    try {
      const response = await fetch("/api/version", {
        cache: "no-store",
        headers,
        signal: abortController.signal,
      });

      if (response.status === 304 || abortController.signal.aborted) {
        return;
      }
      if (!response.ok) {
        return;
      }

      const payload = await response.json().catch(() => null) as VersionInfoResponse | null;
      observeCommitUpdate(payload?.commit);
    } catch {
      // Best-effort fallback only. Errors must stay invisible to users.
    } finally {
      if (versionCheckAbortController === abortController) {
        versionCheckAbortController = null;
      }
      syncVersionCheck();
    }
  }

  function syncVersionCheck() {
    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell || snapshot.updateAvailable) {
      stopVersionCheck();
      return;
    }
    if (versionCheckTimeoutId !== null || versionCheckAbortController) {
      return;
    }

    if (initialVersionCheckPending) {
      initialVersionCheckPending = false;
      void runVersionCheck();
      return;
    }

    versionCheckTimeoutId = window.setTimeout(
      runVersionCheck,
      VERSION_ETAG_CHECK_INTERVAL_MS
    );
  }

  function requestImmediateVersionCheck() {
    if (!clientCommit) return;
    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell || snapshot.updateAvailable) return;
    if (versionCheckAbortController) return;

    if (versionCheckTimeoutId !== null) {
      window.clearTimeout(versionCheckTimeoutId);
      versionCheckTimeoutId = null;
    }

    void runVersionCheck();
  }

  function refreshAutomation() {
    syncSilentActivation();
    syncDeferredAudioAutoApply();
    syncDismissedWatcher();
    syncVersionCheck();
  }

  function clearDismissedState() {
    if (typeof window === "undefined") return;

    autoApplyDismissed = false;
    localStorage.removeItem(DISMISSED_STORAGE_KEY);
    localStorage.removeItem(DISMISSED_UPDATE_DEADLINE_KEY);

    if (snapshot.wasDismissed) {
      setSnapshot((current) => ({ ...current, wasDismissed: false }));
    }
  }

  function trackWaitingWorker(worker: ServiceWorker | null, isNewUpdate: boolean) {
    if (!worker) {
      return;
    }

    waitingWorker = worker;
    autoApplyDismissed = false;

    if (isNewUpdate) {
      clearDismissedState();
    }

    setSnapshot((current) => ({ ...current, updateAvailable: true }));
    logger.info("Update available - new version waiting");

    if (AUTO_APPLY_SW_UPDATES && mode.isAuthenticatedAppShell) {
      wasAudioPlayingOnUpdate = isAudioPlaying;
      logger.info("Audio playing on update:", isAudioPlaying);
    } else {
      wasAudioPlayingOnUpdate = false;
    }

    refreshAutomation();
  }

  function registerServiceWorker() {
    if (!hasServiceWorkerSupport()) {
      return () => {};
    }

    lastActivity = Date.now();
    const hadControllerOnLoad = !!navigator.serviceWorker.controller;
    let isDisposed = false;

    const handleControllerChange = () => {
      waitingWorker = null;
      setSnapshot((current) => ({
        ...current,
        isReady: true,
        updateAvailable: false,
      }));
      clearDismissedState();
      refreshAutomation();

      if (!hadControllerOnLoad) {
        return;
      }

      if (!mode.isAuthenticatedAppShell) {
        logger.info("New service worker activated outside app shell; skipping reload");
        return;
      }

      logger.info("New service worker activated, reloading page...");
      window.location.reload();
    };

    const handleMessage = (event: MessageEvent<SWToClientMessage>) => {
      messageHandlers.forEach((handler) => handler(event.data));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestImmediateVersionCheck();
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.addEventListener("message", handleMessage);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((nextRegistration) => {
        if (isDisposed) return;

        registration = nextRegistration;
        setSnapshot((current) => ({ ...current, isRegistered: true }));

        if (hasServerCommitMismatch) {
          nextRegistration.update().catch(() => {});
        }

        if (nextRegistration.waiting) {
          trackWaitingWorker(nextRegistration.waiting, false);
        }

        if (navigator.serviceWorker.controller || nextRegistration.active) {
          setSnapshot((current) => ({ ...current, isReady: true }));
        }

        nextRegistration.addEventListener("updatefound", () => {
          const newWorker = nextRegistration.installing;
          if (!newWorker) {
            return;
          }

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed") {
              if (navigator.serviceWorker.controller) {
                trackWaitingWorker(newWorker, true);
              } else {
                setSnapshot((current) => ({ ...current, isReady: true }));
              }
            } else if (newWorker.state === "activated") {
              setSnapshot((current) => ({ ...current, isReady: true }));
            }
          });
        });
      })
      .catch((error) => {
        if (isDisposed) return;

        logger.error("Service Worker registration failed:", error);
        setSnapshot((current) => ({ ...current, error }));
      });

    return () => {
      isDisposed = true;

      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      navigator.serviceWorker.removeEventListener("message", handleMessage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);

      clearAutoApplyTimeout();
      stopDismissedWatcher();
      stopVersionCheck();
    };
  }

  return {
    getSnapshot() {
      return { ...snapshot };
    },

    subscribe(listener: ServiceWorkerRuntimeListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeToMessages(handler: ServiceWorkerMessageHandler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },

    setAudioPlaying(nextIsAudioPlaying: boolean) {
      isAudioPlaying = nextIsAudioPlaying;
      refreshAutomation();
    },

    setAppShellMode(nextMode: ServiceWorkerRuntimeMode) {
      mode = nextMode;
      refreshAutomation();
    },

    start() {
      if (registrationCleanup) {
        return registrationCleanup;
      }

      registrationCleanup = registerServiceWorker();
      return () => {
        registrationCleanup?.();
        registrationCleanup = null;
      };
    },

    applyUpdate() {
      return applyAvailableUpdate();
    },

    dismissUpdate() {
      if (typeof window === "undefined") return;

      localStorage.setItem(DISMISSED_STORAGE_KEY, "true");
      localStorage.setItem(
        DISMISSED_UPDATE_DEADLINE_KEY,
        String(Date.now() + AUTO_APPLY_DISMISSED_DEADLINE_MS)
      );
      autoApplyDismissed = false;
      setSnapshot((current) => ({ ...current, wasDismissed: true }));
      refreshAutomation();
    },

    observeCommit(commit: string | null | undefined) {
      observeCommitUpdate(commit);
    },

    postMessage(message: ClientToSWMessage) {
      if (hasServiceWorkerSupport() && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(message);
        return true;
      }

      const activeWorker = registration?.active;
      if (activeWorker) {
        activeWorker.postMessage(message);
        return true;
      }

      return false;
    },
  };
}
