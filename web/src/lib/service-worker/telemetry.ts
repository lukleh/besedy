import type { ReloadBlockerKind } from "@/lib/service-worker/reload-safety";
import { createBrowserId } from "@/lib/browser-id";

export type WebUpdateTelemetryEvent =
  | "client_seen"
  | "update_detected"
  | "worker_ready"
  | "update_dismissed"
  | "apply_requested"
  | "apply_blocked"
  | "version_probe_failed"
  | "activation_started"
  | "activation_delayed"
  | "activation_complete"
  | "reload_fallback"
  | "registration_failed";

export interface WebUpdateTelemetryPayload {
  event: WebUpdateTelemetryEvent;
  attemptId: string;
  clientVersion?: string | null;
  targetVersion?: string | null;
  workerReady?: boolean;
  blockerKinds?: ReloadBlockerKind[];
}

function routeGroup(): string {
  const path = window.location.pathname;
  if (/^\/catalog\/[^/]+\/event(?:\/|$)/.test(path)) return "catalog-event";
  if (/^\/catalog\/[^/]+\/recording(?:\/|$)/.test(path)) return "catalog-recording";
  if (path.startsWith("/catalog")) return "catalog";
  if (path.startsWith("/admin")) return "admin";
  if (path.startsWith("/auth")) return "auth";
  return path === "/" ? "home" : "other";
}

export function createUpdateAttemptId(): string {
  return createBrowserId("update");
}

export function reportWebUpdateEvent(payload: WebUpdateTelemetryPayload): void {
  if (typeof window === "undefined") return;

  fetch("/api/web-update-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, routeGroup: routeGroup() }),
    keepalive: true,
  }).catch(() => {
    // Update telemetry is best-effort and must never affect activation.
  });
}
