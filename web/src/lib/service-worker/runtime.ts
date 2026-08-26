"use client";

import {
  SW_MESSAGE_TYPES,
  type ClientToSWMessage,
  type SWToClientMessage
} from "@/lib/service-worker/messages";
import {
  EMPTY_RELOAD_SAFETY_SUMMARY,
  type ReloadBlockerKind,
  type ReloadSafetySummary
} from "@/lib/service-worker/reload-safety";
import {
  createUpdateAttemptId,
  reportWebUpdateEvent,
  type WebUpdateTelemetryEvent
} from "@/lib/service-worker/telemetry";
import { normalizeWebVersion, selectObservedWebVersion } from "@/lib/service-worker/version";
import { createClientLogger } from "@/lib/log/client";

const AUTO_APPLY_SW_UPDATES = true;
const AUTO_APPLY_DELAY_MS = 1000;
const UPDATE_STATE_STORAGE_KEY = "besedy-sw-update-state";
const LEGACY_DISMISSED_STORAGE_KEY = "besedy-sw-update-dismissed";
const LEGACY_DISMISSED_UPDATE_DEADLINE_KEY = "besedy-sw-update-dismissed-deadline";
const MAX_UPDATE_AGE_MS = 1000 * 60 * 60 * 24;
const EXPIRED_UPDATE_IDLE_MS = 1000 * 60 * 5;
const UPDATE_DEADLINE_CHECK_INTERVAL_MS = 1000 * 30;
const VERSION_ETAG_CHECK_INTERVAL_MS = 1000 * 60 * 60;
const VERSION_PROBE_TIMEOUT_MS = 5000;
const VERSION_PROBE_CACHE_MS = 30_000;
const ACTIVATION_DELAY_NOTICE_MS = 8000;
const CONNECTION_RETRY_MS = 30_000;
const IMMEDIATE_VERSION_CHECK_MIN_INTERVAL_MS = 30_000;
const WAITING_WORKER_VERSION_TIMEOUT_MS = 1000;
const WAITING_WORKER_RETRY_BASE_MS = 1000;
const WAITING_WORKER_RETRY_MAX_MS = 30_000;
const WAITING_WORKER_VERSION_MAX_FAILURES = 5;
const logger = createClientLogger("SW");

let activeVersionObserver: ((version: string) => void) | null = null;

export function registerWebVersionObserver(observer: (version: string) => void): () => void {
  activeVersionObserver = observer;
  return () => {
    if (activeVersionObserver === observer) {
      activeVersionObserver = null;
    }
  };
}

export function notifyWebVersionObserver(version: string | null | undefined): void {
  const observer = activeVersionObserver;
  if (!observer) return;
  if (!version || version === "unknown") return;
  try {
    observer(version);
  } catch {
    // Never let an observer error break the caller (e.g., a fetch).
  }
}

export interface ServiceWorkerRuntimeSnapshot {
  isSupported: boolean;
  isRegistered: boolean;
  isReady: boolean;
  updateAvailable: boolean;
  updateReady: boolean;
  error: Error | null;
  wasDismissed: boolean;
  applyState:
    | "idle"
    | "checking"
    | "blocked"
    | "waiting-for-connection"
    | "applying"
    | "activation-delayed";
  blockedReasons: ReloadBlockerKind[];
}

export interface ServiceWorkerRuntimeMode {
  isAuthenticatedAppShell: boolean;
  shouldSilentlyActivateWaitingWorker: boolean;
}

export type ServiceWorkerRuntimeListener = (snapshot: ServiceWorkerRuntimeSnapshot) => void;

export type ServiceWorkerMessageHandler = (message: SWToClientMessage) => void;

interface VersionInfoResponse {
  webVersion?: string | null;
  commit?: string | null;
}

interface ServiceWorkerRuntimeOptions {
  clientVersion?: string;
  reloadPage?: () => void;
}

interface PersistedUpdateState {
  version: string;
  dismissed: boolean;
  deadline: number;
}

type UpdatePolicy = "manual" | "automatic" | "silent";

function hasServiceWorkerSupport(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

function readPersistedUpdateState(): PersistedUpdateState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(UPDATE_STATE_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedUpdateState>;
    if (
      typeof value.version !== "string" ||
      typeof value.dismissed !== "boolean" ||
      typeof value.deadline !== "number" ||
      !Number.isFinite(value.deadline)
    ) {
      return null;
    }
    return value as PersistedUpdateState;
  } catch {
    return null;
  }
}

function writePersistedUpdateState(state: PersistedUpdateState): void {
  try {
    localStorage.setItem(UPDATE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Update detection must keep working when browser storage is unavailable.
  }
}

function clearPersistedUpdateState(): void {
  try {
    localStorage.removeItem(UPDATE_STATE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_DISMISSED_STORAGE_KEY);
    localStorage.removeItem(LEGACY_DISMISSED_UPDATE_DEADLINE_KEY);
  } catch {
    // Best-effort cleanup for browsers that block local storage.
  }
}

function createInitialSnapshot(): ServiceWorkerRuntimeSnapshot {
  const isSupported = hasServiceWorkerSupport();
  const hasController = isSupported && !!navigator.serviceWorker.controller;

  return {
    isSupported,
    isRegistered: hasController,
    isReady: hasController,
    updateAvailable: false,
    updateReady: false,
    error: null,
    wasDismissed: false,
    applyState: "idle",
    blockedReasons: []
  };
}

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions = {}) {
  const clientVersion = normalizeWebVersion(
    options.clientVersion ?? process.env.NEXT_PUBLIC_WEB_VERSION
  );
  const reloadPage = options.reloadPage ?? (() => window.location.reload());
  let snapshot = createInitialSnapshot();
  let mode: ServiceWorkerRuntimeMode = {
    isAuthenticatedAppShell: false,
    shouldSilentlyActivateWaitingWorker: false
  };
  let reloadSafety: ReloadSafetySummary = EMPTY_RELOAD_SAFETY_SUMMARY;
  let registration: ServiceWorkerRegistration | null = null;
  let waitingWorker: ServiceWorker | null = null;
  let waitingWorkerVersion: string | null = null;
  let waitingWorkerVersionPromise: Promise<string | null> | null = null;
  let autoApplyTimeoutId: number | null = null;
  let activationDelayTimeoutId: number | null = null;
  let connectionRetryTimeoutId: number | null = null;
  let waitingWorkerRetryTimeoutId: number | null = null;
  let waitingWorkerVersionFailures = 0;
  let updateDeadlineWatcherCleanup: (() => void) | null = null;
  let registrationCleanup: (() => void) | null = null;
  let versionCheckTimeoutId: number | null = null;
  let versionCheckAbortController: AbortController | null = null;
  let versionCheckRequestTimeoutId: number | null = null;
  let lastImmediateVersionCheckAt = 0;
  let isStarted = false;
  let lifecycleGeneration = 0;
  let lastActivity = Date.now();
  let autoAppliedExpiredUpdate = false;
  let dismissalRequestedWithoutVersion = false;
  let lastVersion: string | null = clientVersion;
  let initialVersionCheckPending = clientVersion !== null;
  let currentUpdateVersion: string | null = null;
  let hasServerVersionMismatch = false;
  let wasAudioPlayingOnUpdate = false;
  let applyPromise: Promise<boolean> | null = null;
  let lastSuccessfulVersionProbe: {
    version: string;
    checkedAt: number;
  } | null = null;
  let pendingControllerReload = false;
  let pendingControllerReloadPolicy: UpdatePolicy = "automatic";
  let updateAttemptId = createUpdateAttemptId();
  let hasActiveUpdateAttempt = false;
  const reportedTelemetryEvents = new Set<string>();

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
    snapshot = typeof updater === "function" ? updater(snapshot) : { ...snapshot, ...updater };
    emit();
  }

  function reportLifecycleEvent(
    event: WebUpdateTelemetryEvent,
    options: { blockers?: ReloadBlockerKind[]; workerReady?: boolean } = {}
  ) {
    const key = `${updateAttemptId}:${event}`;
    if (reportedTelemetryEvents.has(key)) return;
    reportedTelemetryEvents.add(key);
    reportWebUpdateEvent({
      event,
      attemptId: updateAttemptId,
      clientVersion,
      targetVersion: currentUpdateVersion,
      workerReady: options.workerReady,
      blockerKinds: options.blockers
    });
  }

  function beginUpdateAttempt(forceNew = false) {
    if (!hasActiveUpdateAttempt || forceNew) {
      updateAttemptId = createUpdateAttemptId();
      hasActiveUpdateAttempt = true;
      reportedTelemetryEvents.clear();
    }
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
    if (versionCheckRequestTimeoutId !== null) {
      window.clearTimeout(versionCheckRequestTimeoutId);
      versionCheckRequestTimeoutId = null;
    }
  }

  function stopUpdateDeadlineWatcher() {
    updateDeadlineWatcherCleanup?.();
    updateDeadlineWatcherCleanup = null;
  }

  function getBlockerKinds(policy: UpdatePolicy): ReloadBlockerKind[] {
    return policy === "manual"
      ? reloadSafety.manualBlockerKinds
      : reloadSafety.automaticBlockerKinds;
  }

  function rememberDeferredPolicy(policy: UpdatePolicy) {
    pendingControllerReloadPolicy = policy === "manual" ? "automatic" : policy;
  }

  function setApplyState(
    applyState: ServiceWorkerRuntimeSnapshot["applyState"],
    blockedReasons: ReloadBlockerKind[] = []
  ) {
    setSnapshot((current) => ({ ...current, applyState, blockedReasons }));
  }

  function clearActivationDelayTimeout() {
    if (activationDelayTimeoutId !== null) {
      window.clearTimeout(activationDelayTimeoutId);
      activationDelayTimeoutId = null;
    }
  }

  function clearConnectionRetry() {
    if (connectionRetryTimeoutId !== null) {
      window.clearTimeout(connectionRetryTimeoutId);
      connectionRetryTimeoutId = null;
    }
  }

  function clearWaitingWorkerRetry(resetFailures = false) {
    if (waitingWorkerRetryTimeoutId !== null) {
      window.clearTimeout(waitingWorkerRetryTimeoutId);
      waitingWorkerRetryTimeoutId = null;
    }
    if (resetFailures) waitingWorkerVersionFailures = 0;
  }

  function clearApplyRetries(resetWorkerFailures = false) {
    clearConnectionRetry();
    clearWaitingWorkerRetry(resetWorkerFailures);
  }

  function scheduleConnectionRetry(policy: UpdatePolicy) {
    clearApplyRetries();
    const retryPolicy = policy === "manual" ? "automatic" : policy;
    pendingControllerReloadPolicy = retryPolicy;
    if (!isStarted) return;

    connectionRetryTimeoutId = window.setTimeout(() => {
      connectionRetryTimeoutId = null;
      if (snapshot.wasDismissed) return;
      if (pendingControllerReload) {
        void attemptPendingControllerReload(retryPolicy);
      } else if (snapshot.updateAvailable) {
        void attemptApply(retryPolicy);
      }
    }, CONNECTION_RETRY_MS);
  }

  function scheduleWaitingWorkerRetry(policy: UpdatePolicy) {
    clearApplyRetries();
    const retryPolicy = policy === "manual" ? "automatic" : policy;
    pendingControllerReloadPolicy = retryPolicy;
    if (
      !isStarted ||
      !waitingWorker ||
      waitingWorkerVersionFailures >= WAITING_WORKER_VERSION_MAX_FAILURES
    ) {
      return;
    }

    const exponent = Math.min(Math.max(waitingWorkerVersionFailures - 1, 0), 5);
    const delay = Math.min(
      WAITING_WORKER_RETRY_BASE_MS * 2 ** exponent,
      WAITING_WORKER_RETRY_MAX_MS
    );
    waitingWorkerRetryTimeoutId = window.setTimeout(() => {
      waitingWorkerRetryTimeoutId = null;
      if (waitingWorker && snapshot.updateAvailable && !snapshot.wasDismissed) {
        void attemptApply(retryPolicy);
      }
    }, delay);
  }

  function readWaitingWorkerVersion(worker: ServiceWorker): Promise<string | null> {
    if (typeof MessageChannel === "undefined") return Promise.resolve(null);

    return new Promise((resolve) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (version: string | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        channel.port1.close();
        channel.port2.close();
        resolve(version);
      };
      const timeoutId = window.setTimeout(() => finish(null), WAITING_WORKER_VERSION_TIMEOUT_MS);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const payload = event.data as {
          type?: unknown;
          version?: unknown;
        } | null;
        finish(
          payload?.type === SW_MESSAGE_TYPES.WEB_VERSION && typeof payload.version === "string"
            ? normalizeWebVersion(payload.version)
            : null
        );
      };

      try {
        worker.postMessage({ type: SW_MESSAGE_TYPES.GET_WEB_VERSION }, [channel.port2]);
      } catch {
        finish(null);
      }
    });
  }

  function startWaitingWorkerVersionRead(worker: ServiceWorker): Promise<string | null> | null {
    if (!clientVersion || !("scriptURL" in worker)) return null;

    const versionPromise = readWaitingWorkerVersion(worker);
    waitingWorkerVersionPromise = versionPromise;
    void versionPromise.then((version) => {
      if (waitingWorker !== worker || waitingWorkerVersionPromise !== versionPromise) return;
      waitingWorkerVersionPromise = null;
      if (!version) {
        waitingWorkerVersionFailures += 1;
        return;
      }

      waitingWorkerVersion = version;
      clearWaitingWorkerRetry(true);
      if (lastSuccessfulVersionProbe && version !== lastSuccessfulVersionProbe.version) {
        setSnapshot((current) => ({ ...current, updateReady: false }));
        registration?.update().catch(() => {});
        return;
      }

      if (clientVersion && version === clientVersion) {
        waitingWorker = null;
        setSnapshot((current) => ({
          ...current,
          updateAvailable: hasServerVersionMismatch,
          updateReady: false
        }));
        registration?.update().catch(() => {});
        refreshAutomation();
        return;
      }

      if (!currentUpdateVersion) {
        syncUpdateTarget(version);
      } else if (version !== currentUpdateVersion) {
        setSnapshot((current) => ({ ...current, updateReady: false }));
        registration?.update().catch(() => {});
      }
    });
    return versionPromise;
  }

  async function waitingWorkerStatus(): Promise<"ready" | "missing" | "mismatch" | "unverified"> {
    const worker = waitingWorker;
    if (!worker) return "missing";

    const versionPromise =
      waitingWorkerVersionPromise ??
      (waitingWorkerVersion ? null : startWaitingWorkerVersionRead(worker));
    if (versionPromise) {
      await versionPromise;
    }

    // A newer update may replace the waiting worker while its predecessor is
    // answering the identity handshake. Never activate the replacement until
    // it has been checked independently.
    if (waitingWorker !== worker) return "mismatch";

    // Real ServiceWorker instances always expose scriptURL. If a legacy worker
    // cannot answer the version handshake, its identity cannot be tied to the
    // deployment we just probed, so leave it waiting and retry with backoff.
    if (clientVersion && "scriptURL" in worker && !waitingWorkerVersion) {
      registration?.update().catch(() => {});
      setSnapshot((current) => ({ ...current, updateReady: false }));
      return "unverified";
    }

    const probedVersion = lastSuccessfulVersionProbe?.version;
    if (
      waitingWorkerVersion &&
      ((probedVersion && waitingWorkerVersion !== probedVersion) ||
        (currentUpdateVersion && waitingWorkerVersion !== currentUpdateVersion))
    ) {
      registration?.update().catch(() => {});
      if (probedVersion === clientVersion) {
        clearUpdateState();
        setSnapshot((current) => ({
          ...current,
          updateAvailable: false,
          updateReady: false,
          applyState: "idle",
          blockedReasons: []
        }));
        refreshAutomation();
        return "mismatch";
      }
      setSnapshot((current) => ({ ...current, updateReady: false }));
      return "mismatch";
    }
    return "ready";
  }

  function scheduleActivationDelayNotice() {
    clearActivationDelayTimeout();
    activationDelayTimeoutId = window.setTimeout(() => {
      activationDelayTimeoutId = null;
      if (
        mode.isAuthenticatedAppShell &&
        waitingWorker &&
        !pendingControllerReload &&
        snapshot.applyState === "applying"
      ) {
        reportLifecycleEvent("activation_delayed", { workerReady: true });
        setApplyState("activation-delayed");
      }
    }, ACTIVATION_DELAY_NOTICE_MS);
  }

  async function probeDeploymentVersion(
    allowRecentSuccess = true
  ): Promise<"ready" | "unreachable" | "unversioned" | "target-changed"> {
    const expectedVersion = currentUpdateVersion;
    if (
      allowRecentSuccess &&
      expectedVersion &&
      lastSuccessfulVersionProbe?.version === expectedVersion &&
      Date.now() - lastSuccessfulVersionProbe.checkedAt < VERSION_PROBE_CACHE_MS
    ) {
      return "ready";
    }

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(() => abortController.abort(), VERSION_PROBE_TIMEOUT_MS);

    try {
      const response = await fetch("/api/version", {
        cache: "no-store",
        signal: abortController.signal
      });
      if (!response.ok) {
        reportLifecycleEvent("version_probe_failed");
        return "unreachable";
      }

      const payload = (await response.json().catch(() => null)) as VersionInfoResponse | null;
      const version = selectObservedWebVersion(payload?.webVersion, payload?.commit, clientVersion);
      if (!version) {
        const reportedVersion = normalizeWebVersion(payload?.webVersion ?? payload?.commit);
        if (reportedVersion) return "unversioned";
        reportLifecycleEvent("version_probe_failed");
        return "unreachable";
      }

      observeWebVersionUpdate(version);
      if (expectedVersion && version !== expectedVersion) return "target-changed";

      lastSuccessfulVersionProbe = { version, checkedAt: Date.now() };
      return "ready";
    } catch {
      reportLifecycleEvent("version_probe_failed");
      return "unreachable";
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function activateWaitingWorker(): boolean {
    if (!waitingWorker) return false;

    logger.info("Applying update - sending SKIP_WAITING");
    reportLifecycleEvent("activation_started", { workerReady: true });
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    scheduleActivationDelayNotice();
    wasAudioPlayingOnUpdate = false;
    clearAutoApplyTimeout();
    return true;
  }

  function clearPendingReloadOutsideAppShell(): false {
    pendingControllerReload = false;
    clearUpdateState();
    setSnapshot((current) => ({
      ...current,
      updateAvailable: false,
      updateReady: false,
      applyState: "idle",
      blockedReasons: []
    }));
    return false;
  }

  async function attemptPendingControllerReload(
    policy: UpdatePolicy = pendingControllerReloadPolicy
  ): Promise<boolean> {
    if (!pendingControllerReload) return false;
    if (!mode.isAuthenticatedAppShell) {
      return clearPendingReloadOutsideAppShell();
    }

    const blockers = getBlockerKinds(policy);
    if (blockers.length > 0) {
      rememberDeferredPolicy(policy);
      reportLifecycleEvent("apply_blocked", { blockers });
      setApplyState("blocked", blockers);
      return false;
    }

    setApplyState("checking");
    const probeResult = await probeDeploymentVersion(false);
    if (probeResult === "unreachable" || probeResult === "target-changed") {
      setApplyState(probeResult === "unreachable" ? "waiting-for-connection" : "idle");
      scheduleConnectionRetry(policy);
      return false;
    }

    if (!mode.isAuthenticatedAppShell) {
      return clearPendingReloadOutsideAppShell();
    }

    const blockersAfterProbe = getBlockerKinds(policy);
    if (blockersAfterProbe.length > 0) {
      rememberDeferredPolicy(policy);
      reportLifecycleEvent("apply_blocked", { blockers: blockersAfterProbe });
      setApplyState("blocked", blockersAfterProbe);
      return false;
    }

    pendingControllerReload = false;
    setApplyState("applying");
    reportLifecycleEvent("activation_complete");
    clearUpdateState();
    logger.info("New service worker activated, reloading page...");
    reloadPage();
    return true;
  }

  async function attemptApply(policy: UpdatePolicy): Promise<boolean> {
    if (applyPromise) return applyPromise;

    applyPromise = (async () => {
      if (pendingControllerReload) {
        pendingControllerReloadPolicy = policy;
        return attemptPendingControllerReload(policy);
      }
      if (policy !== "silent" && !mode.isAuthenticatedAppShell) {
        logger.info("Skipping update activation outside app shell");
        return false;
      }
      if (!snapshot.updateAvailable) return false;

      reportLifecycleEvent("apply_requested", {
        workerReady: snapshot.updateReady
      });

      const blockers = getBlockerKinds(policy);
      if (blockers.length > 0) {
        rememberDeferredPolicy(policy);
        reportLifecycleEvent("apply_blocked", { blockers });
        setApplyState("blocked", blockers);
        return false;
      }

      setApplyState("checking");
      const probeResult = await probeDeploymentVersion();
      if (probeResult === "unreachable" || probeResult === "target-changed") {
        setApplyState(probeResult === "unreachable" ? "waiting-for-connection" : "idle");
        scheduleConnectionRetry(policy);
        return false;
      }

      if (policy !== "silent" && !mode.isAuthenticatedAppShell) {
        logger.info("Skipping update activation outside app shell");
        setApplyState("idle");
        return false;
      }

      const blockersAfterProbe = getBlockerKinds(policy);
      if (blockersAfterProbe.length > 0) {
        rememberDeferredPolicy(policy);
        reportLifecycleEvent("apply_blocked", { blockers: blockersAfterProbe });
        setApplyState("blocked", blockersAfterProbe);
        return false;
      }

      setApplyState("applying");
      pendingControllerReloadPolicy = policy;
      if (probeResult === "ready") {
        const workerStatus = await waitingWorkerStatus();
        if (workerStatus === "ready" && activateWaitingWorker()) {
          clearApplyRetries();
          return true;
        }
        if (workerStatus === "mismatch") {
          setApplyState("idle");
          return false;
        }
        if (workerStatus === "unverified") {
          if (waitingWorkerVersionFailures < WAITING_WORKER_VERSION_MAX_FAILURES) {
            setApplyState("idle");
            scheduleWaitingWorkerRetry(policy);
            return false;
          }
        }
      }

      if (policy === "silent") {
        setApplyState("idle");
        return false;
      }

      logger.info("Applying update with a direct page reload");
      reportLifecycleEvent("reload_fallback", { workerReady: false });
      clearApplyRetries();
      wasAudioPlayingOnUpdate = false;
      clearAutoApplyTimeout();
      reloadPage();
      return true;
    })().finally(() => {
      applyPromise = null;
    });

    return applyPromise;
  }

  function shouldAutoApplyExpiredUpdate(): boolean {
    if (autoAppliedExpiredUpdate) return false;
    if (!snapshot.updateAvailable || !currentUpdateVersion) return false;
    if (reloadSafety.automaticBlockerKinds.length > 0) return false;

    const persisted = readPersistedUpdateState();
    if (
      !persisted ||
      persisted.version !== currentUpdateVersion ||
      Date.now() < persisted.deadline
    ) {
      return false;
    }

    const idleMs = Date.now() - lastActivity;
    return document.visibilityState === "hidden" || idleMs >= EXPIRED_UPDATE_IDLE_MS;
  }

  function syncUpdateDeadlineWatcher() {
    stopUpdateDeadlineWatcher();

    if (typeof window === "undefined") return;
    if (!mode.isAuthenticatedAppShell) return;
    if (!snapshot.updateAvailable) {
      autoAppliedExpiredUpdate = false;
      return;
    }

    const runAutoApply = () => {
      if (!shouldAutoApplyExpiredUpdate()) return;
      void attemptApply("automatic").then((applied) => {
        if (applied) autoAppliedExpiredUpdate = true;
      });
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

    const intervalId = window.setInterval(runAutoApply, UPDATE_DEADLINE_CHECK_INTERVAL_MS);

    runAutoApply();

    updateDeadlineWatcherCleanup = () => {
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
    if (reloadSafety.automaticBlockerKinds.includes("audio")) {
      logger.info("Deferring auto-apply while audio is playing");
      return;
    }

    logger.info("Audio stopped, scheduling auto-apply update");
    autoApplyTimeoutId = window.setTimeout(() => {
      logger.info("Auto-applying update (audio stopped)");
      void attemptApply("automatic");
    }, AUTO_APPLY_DELAY_MS);
  }

  function syncSilentActivation() {
    if (!snapshot.updateAvailable) return;
    if (!mode.shouldSilentlyActivateWaitingWorker) return;

    logger.info("Silently activating waiting worker outside app shell");
    void attemptApply("silent");
  }

  function syncUpdateTarget(version: string) {
    const replacesPendingVersion =
      currentUpdateVersion !== null && currentUpdateVersion !== version;
    const persisted = readPersistedUpdateState();
    const nextState: PersistedUpdateState =
      persisted?.version === version
        ? {
            ...persisted,
            dismissed: persisted.dismissed || dismissalRequestedWithoutVersion
          }
        : {
            version,
            dismissed: dismissalRequestedWithoutVersion,
            deadline: Date.now() + MAX_UPDATE_AGE_MS
          };

    currentUpdateVersion = version;
    beginUpdateAttempt(replacesPendingVersion);
    dismissalRequestedWithoutVersion = false;
    writePersistedUpdateState(nextState);
    const workerHasDifferentVersion =
      waitingWorkerVersion !== null && waitingWorkerVersion !== version;
    setSnapshot((current) => ({
      ...current,
      updateReady: workerHasDifferentVersion ? false : current.updateReady,
      wasDismissed: nextState.dismissed
    }));
    if (workerHasDifferentVersion) {
      registration?.update().catch(() => {});
    }
    reportLifecycleEvent("update_detected", {
      workerReady: snapshot.updateReady
    });
  }

  function observeWebVersionUpdate(version: string | null | undefined) {
    const normalizedVersion = normalizeWebVersion(version);
    if (!normalizedVersion) return;
    const previous = lastVersion;
    lastVersion = normalizedVersion;

    if (clientVersion && normalizedVersion === clientVersion) {
      if (hasServerVersionMismatch || currentUpdateVersion) {
        registration?.update().catch(() => {});
        hasServerVersionMismatch = false;
        waitingWorker = null;
        waitingWorkerVersion = null;
        waitingWorkerVersionPromise = null;
        pendingControllerReload = false;
        clearUpdateState();
        setSnapshot((current) => ({
          ...current,
          updateAvailable: false,
          updateReady: false,
          applyState: "idle",
          blockedReasons: []
        }));
        refreshAutomation();
      }
      return;
    }
    if (previous === normalizedVersion) return;

    if (clientVersion && normalizedVersion !== clientVersion) {
      hasServerVersionMismatch = true;
      const targetChanged = currentUpdateVersion !== normalizedVersion;
      if (targetChanged) {
        syncUpdateTarget(normalizedVersion);
      }
      if (!snapshot.updateAvailable) {
        setSnapshot((current) => ({ ...current, updateAvailable: true }));
        logger.info("Update available - server web version differs from client build");

        if (AUTO_APPLY_SW_UPDATES && mode.isAuthenticatedAppShell) {
          wasAudioPlayingOnUpdate = reloadSafety.automaticBlockerKinds.includes("audio");
          logger.info("Audio playing on update:", wasAudioPlayingOnUpdate);
        }
      }
      refreshAutomation();
    }

    registration?.update().catch(() => {});
  }

  async function runVersionCheck() {
    versionCheckTimeoutId = null;

    if (!isStarted) return;
    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell) return;

    const headers = new Headers();
    const generation = lifecycleGeneration;
    if (lastVersion && lastVersion !== "unknown") {
      headers.set("If-None-Match", `"${lastVersion}"`);
    }

    const abortController = new AbortController();
    versionCheckAbortController = abortController;
    versionCheckRequestTimeoutId = window.setTimeout(
      () => abortController.abort(),
      VERSION_PROBE_TIMEOUT_MS
    );
    const requestTimeoutId = versionCheckRequestTimeoutId;

    try {
      const response = await fetch("/api/version", {
        cache: "no-store",
        headers,
        signal: abortController.signal
      });

      if (response.status === 304 || abortController.signal.aborted) {
        return;
      }
      if (!response.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as VersionInfoResponse | null;
      observeWebVersionUpdate(
        selectObservedWebVersion(payload?.webVersion, payload?.commit, clientVersion)
      );
    } catch {
      // Best-effort fallback only. Errors must stay invisible to users.
    } finally {
      if (versionCheckRequestTimeoutId === requestTimeoutId) {
        window.clearTimeout(requestTimeoutId);
        versionCheckRequestTimeoutId = null;
      }
      if (versionCheckAbortController === abortController) {
        versionCheckAbortController = null;
      }
      if (isStarted && generation === lifecycleGeneration) syncVersionCheck();
    }
  }

  function syncVersionCheck() {
    if (!isStarted) return;
    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell) {
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

    versionCheckTimeoutId = window.setTimeout(runVersionCheck, VERSION_ETAG_CHECK_INTERVAL_MS);
  }

  function requestImmediateVersionCheck() {
    if (!isStarted) return;
    if (!clientVersion) return;
    if (!hasServiceWorkerSupport()) return;
    if (!mode.isAuthenticatedAppShell) return;
    if (versionCheckAbortController) return;
    if (Date.now() - lastImmediateVersionCheckAt < IMMEDIATE_VERSION_CHECK_MIN_INTERVAL_MS) {
      return;
    }
    lastImmediateVersionCheckAt = Date.now();

    if (versionCheckTimeoutId !== null) {
      window.clearTimeout(versionCheckTimeoutId);
      versionCheckTimeoutId = null;
    }

    void runVersionCheck();
  }

  function refreshAutomation() {
    syncSilentActivation();
    syncDeferredAudioAutoApply();
    syncUpdateDeadlineWatcher();
    syncVersionCheck();
  }

  function clearUpdateState() {
    if (typeof window === "undefined") return;

    clearActivationDelayTimeout();
    clearApplyRetries(true);
    autoAppliedExpiredUpdate = false;
    dismissalRequestedWithoutVersion = false;
    currentUpdateVersion = null;
    hasServerVersionMismatch = false;
    lastSuccessfulVersionProbe = null;
    hasActiveUpdateAttempt = false;
    clearPersistedUpdateState();

    if (snapshot.wasDismissed) {
      setSnapshot((current) => ({ ...current, wasDismissed: false }));
    }
  }

  function dismissCurrentUpdate() {
    if (typeof window === "undefined") return;

    clearApplyRetries();
    const persisted = readPersistedUpdateState();
    if (currentUpdateVersion) {
      writePersistedUpdateState({
        version: currentUpdateVersion,
        dismissed: true,
        deadline:
          persisted?.version === currentUpdateVersion
            ? persisted.deadline
            : Date.now() + MAX_UPDATE_AGE_MS
      });
    } else {
      dismissalRequestedWithoutVersion = true;
    }
    autoAppliedExpiredUpdate = false;
    reportLifecycleEvent("update_dismissed", {
      workerReady: snapshot.updateReady
    });
    setSnapshot((current) => ({ ...current, wasDismissed: true }));
    refreshAutomation();
  }

  function trackWaitingWorker(worker: ServiceWorker | null) {
    if (!worker) {
      return;
    }

    waitingWorker = worker;
    waitingWorkerVersion = null;
    waitingWorkerVersionPromise = null;
    clearApplyRetries(true);
    beginUpdateAttempt();
    autoAppliedExpiredUpdate = false;
    const persisted = readPersistedUpdateState();

    setSnapshot((current) => ({
      ...current,
      updateAvailable: true,
      updateReady: true,
      wasDismissed:
        persisted && currentUpdateVersion && persisted.version === currentUpdateVersion
          ? persisted.dismissed
          : current.wasDismissed
    }));
    logger.info("Update available - new version waiting");
    reportLifecycleEvent("worker_ready", { workerReady: true });

    void startWaitingWorkerVersionRead(worker);

    if (AUTO_APPLY_SW_UPDATES && mode.isAuthenticatedAppShell) {
      wasAudioPlayingOnUpdate = reloadSafety.automaticBlockerKinds.includes("audio");
      logger.info("Audio playing on update:", wasAudioPlayingOnUpdate);
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
      clearActivationDelayTimeout();
      waitingWorker = null;
      waitingWorkerVersion = null;
      waitingWorkerVersionPromise = null;
      clearWaitingWorkerRetry(true);
      setSnapshot((current) => ({
        ...current,
        isReady: true,
        updateReady: false
      }));

      if (!hadControllerOnLoad) {
        clearUpdateState();
        setSnapshot((current) => ({
          ...current,
          updateAvailable: false,
          applyState: "idle",
          blockedReasons: []
        }));
        refreshAutomation();
        return;
      }

      if (!mode.isAuthenticatedAppShell) {
        logger.info("New service worker activated outside app shell; skipping reload");
        clearUpdateState();
        setSnapshot((current) => ({
          ...current,
          updateAvailable: false,
          applyState: "idle",
          blockedReasons: []
        }));
        refreshAutomation();
        return;
      }

      pendingControllerReload = true;
      refreshAutomation();
      void attemptPendingControllerReload();
    };

    const handleMessage = (event: MessageEvent<SWToClientMessage>) => {
      messageHandlers.forEach((handler) => handler(event.data));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        requestImmediateVersionCheck();
      }
    };

    const handleOnline = () => {
      refreshAutomation();
      requestImmediateVersionCheck();
      if (snapshot.wasDismissed) return;
      if (pendingControllerReload) {
        clearApplyRetries();
        void attemptPendingControllerReload();
      } else if (snapshot.applyState === "waiting-for-connection" && snapshot.updateAvailable) {
        clearApplyRetries();
        void attemptApply(pendingControllerReloadPolicy);
      }
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    navigator.serviceWorker.addEventListener("message", handleMessage);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== UPDATE_STATE_STORAGE_KEY || !currentUpdateVersion) return;
      const persisted = readPersistedUpdateState();
      if (persisted?.version !== currentUpdateVersion) return;
      if (persisted.dismissed !== snapshot.wasDismissed) {
        setSnapshot((current) => ({
          ...current,
          wasDismissed: persisted.dismissed
        }));
      }
    };
    window.addEventListener("storage", handleStorage);

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((nextRegistration) => {
        if (isDisposed) return;

        registration = nextRegistration;
        setSnapshot((current) => ({ ...current, isRegistered: true }));

        if (hasServerVersionMismatch) {
          nextRegistration.update().catch(() => {});
        }

        if (nextRegistration.waiting) {
          trackWaitingWorker(nextRegistration.waiting);
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
                trackWaitingWorker(newWorker);
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
        reportLifecycleEvent("registration_failed");
        setSnapshot((current) => ({ ...current, error }));
      });

    return () => {
      isDisposed = true;

      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      navigator.serviceWorker.removeEventListener("message", handleMessage);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("storage", handleStorage);

      clearAutoApplyTimeout();
      clearActivationDelayTimeout();
      clearConnectionRetry();
      clearWaitingWorkerRetry(true);
      stopUpdateDeadlineWatcher();
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

    setReloadSafety(nextReloadSafety: ReloadSafetySummary) {
      reloadSafety = {
        automaticBlockerKinds: [...nextReloadSafety.automaticBlockerKinds],
        manualBlockerKinds: [...nextReloadSafety.manualBlockerKinds]
      };
      if (snapshot.applyState === "blocked") {
        const policy = pendingControllerReloadPolicy;
        const blockers = getBlockerKinds(policy);
        if (blockers.length === 0) {
          if (pendingControllerReload) {
            void attemptPendingControllerReload(policy);
          } else if (snapshot.updateAvailable) {
            void attemptApply(policy);
          }
        } else {
          setApplyState("blocked", blockers);
        }
      }
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

      isStarted = true;
      lifecycleGeneration += 1;
      reportLifecycleEvent("client_seen");
      registrationCleanup = registerServiceWorker();
      refreshAutomation();
      return () => {
        isStarted = false;
        lifecycleGeneration += 1;
        registrationCleanup?.();
        registrationCleanup = null;
      };
    },

    applyUpdate() {
      clearApplyRetries();
      pendingControllerReloadPolicy = "manual";
      return attemptApply("manual");
    },

    cancelPendingApply() {
      if (snapshot.applyState !== "waiting-for-connection") return;
      clearApplyRetries();
      pendingControllerReloadPolicy = "automatic";
      setApplyState("idle");
      dismissCurrentUpdate();
    },

    dismissUpdate() {
      dismissCurrentUpdate();
    },

    observeWebVersion(version: string | null | undefined) {
      observeWebVersionUpdate(version);
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
    }
  };
}
