"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "@/lib/api/fetch-json";

type PermissionState = "granted" | "denied" | "default" | "unsupported";

interface UsePushNotificationsResult {
  /** Browser permission state */
  permission: PermissionState;
  /** Whether push notifications are supported */
  isSupported: boolean;
  /** Whether the user is subscribed to push */
  isSubscribed: boolean;
  /** Loading state for async operations */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Request permission and subscribe */
  subscribe: () => Promise<boolean>;
  /** Unsubscribe from push */
  unsubscribe: () => Promise<boolean>;
}

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/**
 * Convert URL-safe base64 to Uint8Array for applicationServerKey
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Hook for managing push notification subscriptions.
 */
export function usePushNotifications(): UsePushNotificationsResult {
  const [permission, setPermission] = useState<PermissionState>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isSupported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY;

  // Check current state on mount
  useEffect(() => {
    if (!isSupported) {
      setPermission("unsupported");
      setIsLoading(false);
      return;
    }

    const checkState = async () => {
      try {
        // Check notification permission
        setPermission(Notification.permission as PermissionState);

        // Check if we have an active subscription
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        setIsSubscribed(!!subscription);
      } catch (err) {
        console.error("[Push] Failed to check state:", err);
      } finally {
        setIsLoading(false);
      }
    };

    checkState();
  }, [isSupported]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported || !VAPID_PUBLIC_KEY) {
      setError("Push notifications not supported");
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Request permission
      const permissionResult = await Notification.requestPermission();
      setPermission(permissionResult as PermissionState);

      if (permissionResult !== "granted") {
        setError("Notification permission denied");
        return false;
      }

      // Get service worker registration
      const registration = await navigator.serviceWorker.ready;

      // Subscribe to push
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
      });

      // Send subscription to server
      await fetchJson("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });

      setIsSubscribed(true);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to subscribe";
      setError(message);
      console.error("[Push] Subscribe error:", err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      return false;
    }

    setIsLoading(true);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        // Remove from server FIRST - if this fails, browser stays subscribed
        // (consistent state). Server will clean up stale subscriptions on push failure.
        await fetchJson("/api/notifications/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });

        // Then unsubscribe from browser push manager
        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to unsubscribe";
      setError(message);
      console.error("[Push] Unsubscribe error:", err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isSupported]);

  return {
    permission,
    isSupported,
    isSubscribed,
    isLoading,
    error,
    subscribe,
    unsubscribe,
  };
}
