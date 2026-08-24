"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReloadBlockerKind } from "@/lib/service-worker/reload-safety";
import { createBrowserId } from "@/lib/browser-id";

const CHANNEL_NAME = "besedy-reload-safety";
const HEARTBEAT_INTERVAL_MS = 15_000;
const REMOTE_STATE_TTL_MS = 45_000;

export type { ReloadBlockerKind } from "@/lib/service-worker/reload-safety";

export interface ReloadBlocker {
  id: string;
  kind: ReloadBlockerKind;
  blocksAutomatic: boolean;
  blocksManual: boolean;
}

export interface ReloadSafetySnapshot {
  automaticBlockers: ReloadBlocker[];
  manualBlockers: ReloadBlocker[];
  automaticBlockerKinds: ReloadBlockerKind[];
  manualBlockerKinds: ReloadBlockerKind[];
  blocksAutomatic: boolean;
  blocksManual: boolean;
}

type ReloadSafetyMessage =
  | { type: "hello"; tabId: string }
  | { type: "state"; tabId: string; blockers: ReloadBlocker[] }
  | { type: "clear"; tabId: string };

interface ReloadSafetyContextValue extends ReloadSafetySnapshot {
  registerBlocker: (blocker: ReloadBlocker) => () => void;
}

const ReloadSafetyContext = createContext<ReloadSafetyContextValue | undefined>(
  undefined
);

function createTabId(): string {
  return createBrowserId("tab");
}

function isReloadBlocker(value: unknown): value is ReloadBlocker {
  if (!value || typeof value !== "object") return false;
  const blocker = value as Partial<ReloadBlocker>;
  return (
    typeof blocker.id === "string" &&
    (blocker.kind === "audio" ||
      blocker.kind === "unsaved-changes" ||
      blocker.kind === "critical-mutation") &&
    typeof blocker.blocksAutomatic === "boolean" &&
    typeof blocker.blocksManual === "boolean"
  );
}

function uniqueKinds(blockers: ReloadBlocker[]): ReloadBlockerKind[] {
  return Array.from(new Set(blockers.map((blocker) => blocker.kind)));
}

export function ReloadSafetyProvider({ children }: { children: ReactNode }) {
  const tabIdRef = useRef(createTabId());
  const localBlockersRef = useRef(new Map<string, ReloadBlocker>());
  const remoteObservedAtRef = useRef(new Map<string, number>());
  const channelRef = useRef<BroadcastChannel | null>(null);
  const [localBlockers, setLocalBlockers] = useState<ReloadBlocker[]>([]);
  const [remoteTabs, setRemoteTabs] = useState<Map<string, ReloadBlocker[]>>(
    () => new Map()
  );

  const publishState = useCallback(() => {
    channelRef.current?.postMessage({
      type: "state",
      tabId: tabIdRef.current,
      blockers: Array.from(localBlockersRef.current.values()),
    } satisfies ReloadSafetyMessage);
  }, []);

  const registerBlocker = useCallback((blocker: ReloadBlocker) => {
    localBlockersRef.current.set(blocker.id, blocker);
    setLocalBlockers(Array.from(localBlockersRef.current.values()));

    return () => {
      const current = localBlockersRef.current.get(blocker.id);
      if (current !== blocker) return;
      localBlockersRef.current.delete(blocker.id);
      setLocalBlockers(Array.from(localBlockersRef.current.values()));
    };
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;

    const channel = new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;

    channel.addEventListener("message", (event: MessageEvent<unknown>) => {
      const message = event.data as Partial<ReloadSafetyMessage> | null;
      if (!message || message.tabId === tabIdRef.current) return;

      if (message.type === "hello" && typeof message.tabId === "string") {
        publishState();
        return;
      }

      if (message.type === "clear" && typeof message.tabId === "string") {
        remoteObservedAtRef.current.delete(message.tabId);
        setRemoteTabs((current) => {
          if (!current.has(message.tabId!)) return current;
          const next = new Map(current);
          next.delete(message.tabId!);
          return next;
        });
        return;
      }

      if (
        message.type !== "state" ||
        typeof message.tabId !== "string" ||
        !Array.isArray(message.blockers) ||
        !message.blockers.every(isReloadBlocker)
      ) {
        return;
      }

      remoteObservedAtRef.current.set(message.tabId, Date.now());

      setRemoteTabs((current) => {
        const existing = current.get(message.tabId!);
        if (
          existing?.length === message.blockers!.length &&
          existing.every((blocker, index) => {
            const next = message.blockers![index];
            return (
              blocker.id === next.id &&
              blocker.kind === next.kind &&
              blocker.blocksAutomatic === next.blocksAutomatic &&
              blocker.blocksManual === next.blocksManual
            );
          })
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(message.tabId!, message.blockers!);
        return next;
      });
    });

    channel.postMessage({
      type: "hello",
      tabId: tabIdRef.current,
    } satisfies ReloadSafetyMessage);
    publishState();

    const intervalId = window.setInterval(() => {
      const cutoff = Date.now() - REMOTE_STATE_TTL_MS;
      setRemoteTabs((current) => {
        const expiredTabIds = Array.from(current.keys()).filter(
          (tabId) => (remoteObservedAtRef.current.get(tabId) ?? 0) < cutoff
        );
        if (expiredTabIds.length === 0) return current;
        const next = new Map(current);
        expiredTabIds.forEach((tabId) => {
          next.delete(tabId);
          remoteObservedAtRef.current.delete(tabId);
        });
        return next.size === current.size ? current : next;
      });
      publishState();
    }, HEARTBEAT_INTERVAL_MS);

    const clearTab = () => {
      channel.postMessage({
        type: "clear",
        tabId: tabIdRef.current,
      } satisfies ReloadSafetyMessage);
    };
    window.addEventListener("pagehide", clearTab);

    return () => {
      clearTab();
      window.removeEventListener("pagehide", clearTab);
      window.clearInterval(intervalId);
      channel.close();
      if (channelRef.current === channel) {
        channelRef.current = null;
      }
    };
  }, [publishState]);

  useEffect(() => {
    publishState();
  }, [localBlockers, publishState]);

  const snapshot = useMemo<ReloadSafetySnapshot>(() => {
    const blockers = [
      ...localBlockers,
      ...Array.from(remoteTabs.entries()).flatMap(([tabId, blockers]) =>
        blockers.map((blocker) => ({
          ...blocker,
          id: `${tabId}:${blocker.id}`,
        }))
      ),
    ];
    const automaticBlockers = blockers.filter(
      (blocker) => blocker.blocksAutomatic
    );
    const manualBlockers = blockers.filter((blocker) => blocker.blocksManual);

    return {
      automaticBlockers,
      manualBlockers,
      automaticBlockerKinds: uniqueKinds(automaticBlockers),
      manualBlockerKinds: uniqueKinds(manualBlockers),
      blocksAutomatic: automaticBlockers.length > 0,
      blocksManual: manualBlockers.length > 0,
    };
  }, [localBlockers, remoteTabs]);

  const value = useMemo<ReloadSafetyContextValue>(
    () => ({ ...snapshot, registerBlocker }),
    [registerBlocker, snapshot]
  );

  return (
    <ReloadSafetyContext.Provider value={value}>
      {children}
    </ReloadSafetyContext.Provider>
  );
}

export function useReloadSafety(): ReloadSafetyContextValue {
  const context = useContext(ReloadSafetyContext);
  if (!context) {
    throw new Error("useReloadSafety must be used within a ReloadSafetyProvider");
  }
  return context;
}

export function useReloadBlocker(blocker: ReloadBlocker, active: boolean) {
  const { registerBlocker } = useReloadSafety();
  const { id, kind, blocksAutomatic, blocksManual } = blocker;

  useEffect(() => {
    if (!active) return;
    return registerBlocker({ id, kind, blocksAutomatic, blocksManual });
  }, [
    active,
    blocksAutomatic,
    blocksManual,
    id,
    kind,
    registerBlocker,
  ]);
}
