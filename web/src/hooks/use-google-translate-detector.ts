"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "gt-warning-dismissed";

/**
 * Safe sessionStorage access (throws in some privacy modes)
 */
function getStorageItem(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setStorageItem(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore - storage not available
  }
}

/**
 * Detects if Google Translate is active on the page
 */
function isGoogleTranslateActive(): boolean {
  const html = document.documentElement;
  return (
    html.classList.contains("translated-ltr") ||
    html.classList.contains("translated-rtl") ||
    (html.hasAttribute("translate") && html.getAttribute("translate") !== "no") ||
    document.getElementById("goog-gt-tt") !== null ||
    document.querySelector("iframe.goog-te-banner-frame") !== null
  );
}

/**
 * Hook to detect Google Translate activation and provide dismissal functionality.
 *
 * Detection strategy:
 * 1. On mount: Check initial document state for existing translation
 * 2. MutationObserver: Watch for subsequent translation activation
 * 3. Disconnects after detection to save CPU
 *
 * @returns detected - true if Google Translate is active
 * @returns dismiss - function to dismiss the warning for this session
 * @returns isDismissed - true if user has dismissed the warning
 */
export function useGoogleTranslateDetector() {
  const [detected, setDetected] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    // Restore dismissal state from sessionStorage
    if (getStorageItem(STORAGE_KEY) === "true") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: syncing from sessionStorage
      setIsDismissed(true);
    }

    // Check initial state on mount
    if (isGoogleTranslateActive()) {
      setDetected(true);
      return; // Already detected, no need to observe
    }

    // Track detection state outside React for callback access
    let alreadyDetected = false;

    const handleDetection = () => {
      if (alreadyDetected) return false;
      if (isGoogleTranslateActive()) {
        alreadyDetected = true;
        setDetected(true);
        return true;
      }
      return false;
    };

    // Watch for changes on <html> (subtree: true catches GT iframe anywhere)
    const observer = new MutationObserver(() => {
      if (handleDetection()) {
        observer.disconnect();
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "lang", "translate"],
      childList: true,
      subtree: true,
    });

    // Fallback: periodic check every 500ms for 5 seconds
    // Catches cases where MutationObserver might miss the event
    // (e.g., if GT modifies DOM before observer is fully set up)
    const intervalId = setInterval(() => {
      if (handleDetection()) {
        clearInterval(intervalId);
        observer.disconnect();
      }
    }, 500);

    // Stop polling after 5 seconds to save CPU
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
    }, 5000);

    return () => {
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
  }, []);

  const dismiss = useCallback(() => {
    setIsDismissed(true);
    setStorageItem(STORAGE_KEY, "true");
  }, []);

  return { detected, dismiss, isDismissed };
}
