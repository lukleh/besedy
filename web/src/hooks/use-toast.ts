"use client";

import { useCallback, useSyncExternalStore } from "react";
import { toast as sonnerToast } from "sonner";
import { useIsDesktop } from "@/hooks/use-media-query";

interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface MobileToastState {
  id: number;
  title?: string;
  description?: string;
  variant: "default" | "destructive";
}

let mobileToastState: MobileToastState | null = null;
const mobileToastListeners = new Set<() => void>();

const notifyMobileToast = () => {
  for (const listener of mobileToastListeners) {
    listener();
  }
};

const subscribeMobileToast = (listener: () => void) => {
  mobileToastListeners.add(listener);
  return () => mobileToastListeners.delete(listener);
};

const getMobileToastSnapshot = () => mobileToastState;
const getMobileToastServerSnapshot = () => null;

const showMobileToast = (options: ToastOptions) => {
  mobileToastState = {
    id: Date.now(),
    title: options.title,
    description: options.description,
    variant: options.variant ?? "default",
  };
  notifyMobileToast();
};

export const dismissMobileToast = () => {
  mobileToastState = null;
  notifyMobileToast();
};

export const useMobileToastState = () =>
  useSyncExternalStore(
    subscribeMobileToast,
    getMobileToastSnapshot,
    getMobileToastServerSnapshot
  );

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as typeof window & { __besedyToast?: (options: ToastOptions) => void }).__besedyToast =
    (options: ToastOptions) => showMobileToast(options);
}

export function useToast() {
  const isDesktop = useIsDesktop();

  const toast = useCallback(
    ({ title, description, variant }: ToastOptions) => {
      const resolvedVariant = variant ?? "default";
      if (isDesktop) {
        if (resolvedVariant === "destructive") {
          sonnerToast.error(title, { description });
        } else {
          sonnerToast.success(title, { description });
        }
        return;
      }
      showMobileToast({ title, description, variant: resolvedVariant });
    },
    [isDesktop]
  );

  return { toast };
}
