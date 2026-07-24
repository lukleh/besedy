"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The BeforeInstallPromptEvent interface for PWA install prompts.
 * This event is fired when the browser determines the app is installable.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

interface InstalledRelatedApp {
  platform: string;
  url?: string;
  id?: string;
  version?: string;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

/**
 * Global capture of beforeinstallprompt event.
 * This runs at module load time, before React mounts, to ensure we don't miss
 * the event which fires early during page load.
 */
let globalDeferredPrompt: BeforeInstallPromptEvent | null = null;
let globalPromptWasUsed = false;

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e: BeforeInstallPromptEvent) => {
    e.preventDefault();
    // Only store if not already used (prompt can only be used once)
    if (!globalPromptWasUsed) {
      globalDeferredPrompt = e;
    }
  });

  window.addEventListener("appinstalled", () => {
    globalDeferredPrompt = null;
    globalPromptWasUsed = true;
  });
}

/**
 * Hook to manage PWA install prompt.
 *
 * Captures the beforeinstallprompt event and provides methods to:
 * - Check if the app is installable
 * - Trigger the native install dialog
 * - Track if the user has dismissed the prompt
 *
 * @returns Object with install state and methods
 *
 * @example
 * ```tsx
 * function InstallBanner() {
 *   const { isInstallable, isInstalled, promptInstall, dismiss } = useInstallPrompt();
 *
 *   if (!isInstallable || isInstalled) return null;
 *
 *   return (
 *     <div>
 *       <button onClick={promptInstall}>Install App</button>
 *       <button onClick={dismiss}>Later</button>
 *     </div>
 *   );
 * }
 * ```
 */
/**
 * Check if app is already installed (runs during initialization)
 */
function checkIsInstalled(): boolean {
  if (typeof window === "undefined") return false;

  // Check standalone mode (Chrome/Android)
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }

  // Check iOS standalone mode
  if (
    "standalone" in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone
  ) {
    return true;
  }

  return false;
}

function getInstalledRelatedApps():
  | (() => Promise<InstalledRelatedApp[]>)
  | undefined {
  if (typeof navigator === "undefined") return undefined;
  const candidate = (navigator as Navigator & {
    getInstalledRelatedApps?: () => Promise<InstalledRelatedApp[]>;
  }).getInstalledRelatedApps;

  return typeof candidate === "function" ? candidate.bind(navigator) : undefined;
}

async function checkRelatedAppsInstalled(): Promise<boolean> {
  const getter = getInstalledRelatedApps();
  if (!getter) return false;
  try {
    const relatedApps = await getter();
    return relatedApps.length > 0;
  } catch {
    return false;
  }
}

/**
 * Detect iOS / iPadOS where native install prompt is not available.
 */
function checkIsIos(): boolean {
  if (typeof navigator === "undefined") return false;

  const ua = navigator.userAgent.toLowerCase();
  const isAppleMobile = /iphone|ipad|ipod/.test(ua);
  const isIpadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  return isAppleMobile || isIpadOs;
}

/**
 * Check if user previously dismissed the prompt (permanent)
 */
function checkIsDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem("pwa-install-dismissed") !== null;
}

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  // Initialize with SSR-safe values to avoid hydration mismatch
  const [isInstalled, setIsInstalled] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isIos, setIsIos] = useState(false);

  // Check installed/dismissed state and grab global prompt on mount
  useEffect(() => {
    queueMicrotask(() => {
      setIsIos(checkIsIos());
      const installed = checkIsInstalled();
      setIsInstalled(installed);
      if (!installed && globalDeferredPrompt) {
        // Grab the globally captured prompt if we're not installed
        setDeferredPrompt(globalDeferredPrompt);
      }
      if (checkIsDismissed()) {
        setIsDismissed(true);
      }
    });

    void checkRelatedAppsInstalled().then((installed) => {
      if (installed) {
        setIsInstalled(true);
        setDeferredPrompt(null);
        globalDeferredPrompt = null;
      }
    });
  }, []);

  // Re-check install state when display mode or app visibility changes (e.g., after uninstall)
  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncInstalledState = () => {
      const installed = checkIsInstalled();
      setIsInstalled(installed);
      if (!installed) {
        void checkRelatedAppsInstalled().then((relatedInstalled) => {
          if (relatedInstalled) {
            setIsInstalled(true);
            setDeferredPrompt(null);
            globalDeferredPrompt = null;
          }
        });
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        syncInstalledState();
      }
    };

    const displayModeQuery = window.matchMedia("(display-mode: standalone)");
    const addDisplayModeListener = () => {
      if (typeof displayModeQuery.addEventListener === "function") {
        displayModeQuery.addEventListener("change", syncInstalledState);
      } else if (typeof displayModeQuery.addListener === "function") {
        displayModeQuery.addListener(syncInstalledState);
      }
    };
    const removeDisplayModeListener = () => {
      if (typeof displayModeQuery.removeEventListener === "function") {
        displayModeQuery.removeEventListener("change", syncInstalledState);
      } else if (typeof displayModeQuery.removeListener === "function") {
        displayModeQuery.removeListener(syncInstalledState);
      }
    };

    addDisplayModeListener();
    window.addEventListener("pageshow", syncInstalledState);
    window.addEventListener("focus", syncInstalledState);
    window.addEventListener("visibilitychange", handleVisibility);

    return () => {
      removeDisplayModeListener();
      window.removeEventListener("pageshow", syncInstalledState);
      window.removeEventListener("focus", syncInstalledState);
      window.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  // Listen for future beforeinstallprompt events (e.g., after uninstall + new session)
  useEffect(() => {
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      if (checkIsInstalled()) return;
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Store the event for later use
      setDeferredPrompt(e);
      // Also update global in case other hook instances need it
      if (!globalPromptWasUsed) {
        globalDeferredPrompt = e;
      }
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
      globalDeferredPrompt = null;
      globalPromptWasUsed = true;
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  /**
   * Trigger the native install prompt
   */
  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;

    // Mark as used before prompting (prompt can only be used once)
    globalPromptWasUsed = true;
    globalDeferredPrompt = null;

    // Show the install prompt
    await deferredPrompt.prompt();

    // Wait for the user's choice
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setIsInstalled(true);
    }

    // Clear the deferred prompt - it can only be used once
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  /**
   * Dismiss the install prompt permanently (keeps deferredPrompt for menu)
   */
  const dismiss = useCallback(() => {
    localStorage.setItem("pwa-install-dismissed", "1");
    setIsDismissed(true);
  }, []);

  const hasInstallPrompt = !!deferredPrompt;

  return {
    /** Whether the app can be installed and banner should show (prompt available, not dismissed) */
    isInstallable: hasInstallPrompt && !isDismissed && !isInstalled,
    /** Whether install can be triggered from menu (not installed) */
    canPromptInstall: !isInstalled,
    /** Whether the browser provided a native install prompt */
    hasInstallPrompt,
    /** Whether the app is already installed */
    isInstalled,
    /** Whether the device is iOS/iPadOS (manual install flow) */
    isIos,
    /** Whether the user has dismissed the prompt */
    isDismissed,
    /** Trigger the native install dialog */
    promptInstall,
    /** Dismiss the prompt permanently */
    dismiss,
  };
}
