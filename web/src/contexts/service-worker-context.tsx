"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { useAudioPlayback } from "@/contexts/audio-playback-context";
import { useSession } from "@/contexts/session-context";
import type { SWToClientMessage, ClientToSWMessage } from "@/lib/service-worker/messages";
import {
  createServiceWorkerRuntime,
  registerCommitObserver,
  type ServiceWorkerMessageHandler,
  type ServiceWorkerRuntimeSnapshot,
} from "@/lib/service-worker/runtime";

/**
 * Service Worker state and controls context.
 *
 * Automatic version checks and reloads are restricted to the authenticated app
 * shell. Auth and logged-out pages can still silently activate an already
 * waiting worker so callback-routing fixes take effect before login, but they
 * never trigger a reload there.
 */

type MessageHandler = ServiceWorkerMessageHandler;

interface ServiceWorkerContextValue extends ServiceWorkerRuntimeSnapshot {
  applyUpdate: () => void;
  dismissUpdate: () => void;
  postMessage: (message: ClientToSWMessage) => boolean;
  subscribe: (handler: MessageHandler) => () => void;
}

const ServiceWorkerContext = createContext<ServiceWorkerContextValue | undefined>(undefined);

export function ServiceWorkerProvider({ children }: { children: ReactNode }) {
  const runtime = useMemo(() => createServiceWorkerRuntime(), []);
  const { isAudioPlaying } = useAudioPlayback();
  const { session, isPending } = useSession();
  const pathname = usePathname() ?? "/";
  const isAuthPage = pathname.startsWith("/auth");
  const isAuthenticatedAppShell = Boolean(session) && !isPending && !isAuthPage;
  const shouldSilentlyActivateWaitingWorker = isAuthPage || (!session && !isPending);
  const [state, setState] = useState<ServiceWorkerRuntimeSnapshot>(() => runtime.getSnapshot());

  useEffect(() => {
    return runtime.subscribe(setState);
  }, [runtime]);

  useEffect(() => {
    runtime.setAppShellMode({
      isAuthenticatedAppShell,
      shouldSilentlyActivateWaitingWorker,
    });
  }, [isAuthenticatedAppShell, runtime, shouldSilentlyActivateWaitingWorker]);

  useEffect(() => {
    runtime.setAudioPlaying(isAudioPlaying);
  }, [isAudioPlaying, runtime]);

  useEffect(() => {
    return runtime.start();
  }, [runtime]);

  useEffect(() => {
    return registerCommitObserver(runtime.observeCommit);
  }, [runtime]);

  const applyUpdate = useCallback(() => {
    runtime.applyUpdate();
  }, [runtime]);

  const dismissUpdate = useCallback(() => {
    runtime.dismissUpdate();
  }, [runtime]);

  const postMessage = useCallback((message: ClientToSWMessage) => {
    return runtime.postMessage(message);
  }, [runtime]);

  const subscribe = useCallback((handler: MessageHandler) => {
    return runtime.subscribeToMessages(handler);
  }, [runtime]);

  const value = useMemo(() => ({
    ...state,
    applyUpdate,
    dismissUpdate,
    postMessage,
    subscribe,
  }), [state, applyUpdate, dismissUpdate, postMessage, subscribe]);

  return (
    <ServiceWorkerContext.Provider
      value={value}
    >
      {children}
    </ServiceWorkerContext.Provider>
  );
}

export function useServiceWorker(): ServiceWorkerContextValue {
  const context = useContext(ServiceWorkerContext);
  if (!context) {
    throw new Error("useServiceWorker must be used within a ServiceWorkerProvider");
  }
  return context;
}

export type { SWToClientMessage };
