import { NextRequest, NextResponse } from "next/server";
import { WebUpdateEventType } from "@/generated/prisma/enums";
import prisma from "@/lib/db";
import { getCurrentUserId } from "@/lib/auth/permissions";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY_SIZE = 2048;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PER_CLIENT_RATE_LIMIT = 30;
const GLOBAL_RATE_LIMIT = 1200;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ROUTE_GROUPS = new Set([
  "home",
  "catalog",
  "catalog-event",
  "catalog-recording",
  "admin",
  "auth",
  "other",
]);
const BLOCKER_KINDS = new Set(["audio", "unsaved-changes", "critical-mutation"]);

const EVENT_TYPES: Record<string, WebUpdateEventType> = {
  client_seen: WebUpdateEventType.CLIENT_SEEN,
  update_detected: WebUpdateEventType.UPDATE_DETECTED,
  worker_ready: WebUpdateEventType.WORKER_READY,
  update_dismissed: WebUpdateEventType.UPDATE_DISMISSED,
  apply_requested: WebUpdateEventType.APPLY_REQUESTED,
  apply_blocked: WebUpdateEventType.APPLY_BLOCKED,
  version_probe_failed: WebUpdateEventType.VERSION_PROBE_FAILED,
  activation_started: WebUpdateEventType.ACTIVATION_STARTED,
  activation_delayed: WebUpdateEventType.ACTIVATION_DELAYED,
  activation_complete: WebUpdateEventType.ACTIVATION_COMPLETE,
  reload_fallback: WebUpdateEventType.RELOAD_FALLBACK,
  registration_failed: WebUpdateEventType.REGISTRATION_FAILED,
};

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function browserFamily(userAgent: string | null): string | null {
  if (!userAgent) return null;
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/CriOS\//.test(userAgent)) return "Chrome iOS";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/FxiOS\//.test(userAgent)) return "Firefox iOS";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

function safeVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : null;
}

export async function POST(request: NextRequest) {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const event = typeof body.event === "string" ? EVENT_TYPES[body.event] : undefined;
  if (!event || typeof body.attemptId !== "string" || !ATTEMPT_PATTERN.test(body.attemptId)) {
    return NextResponse.json({ error: "Invalid update event" }, { status: 400 });
  }

  const ip = clientIp(request);
  if (
    !checkRateLimit(`web-update:${ip}`, PER_CLIENT_RATE_LIMIT, RATE_LIMIT_WINDOW_MS) ||
    !checkRateLimit("web-update:global", GLOBAL_RATE_LIMIT, RATE_LIMIT_WINDOW_MS)
  ) {
    return NextResponse.json(
      { error: "Too many update events" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }

  const blockerKinds = Array.isArray(body.blockerKinds)
    ? Array.from(
        new Set(
          body.blockerKinds.filter(
            (kind): kind is string => typeof kind === "string" && BLOCKER_KINDS.has(kind)
          )
        )
      )
    : [];
  const routeGroup =
    typeof body.routeGroup === "string" && ROUTE_GROUPS.has(body.routeGroup)
      ? body.routeGroup
      : null;

  try {
    await prisma.webUpdateEvent.create({
      data: {
        userId: await getCurrentUserId(),
        event,
        attemptId: body.attemptId,
        clientVersion: safeVersion(body.clientVersion),
        targetVersion: safeVersion(body.targetVersion),
        workerReady: typeof body.workerReady === "boolean" ? body.workerReady : null,
        blockerKinds,
        routeGroup,
        browser: browserFamily(request.headers.get("user-agent")),
      },
    });
  } catch {
    // Telemetry storage must not create a retry storm in old or partially deployed clients.
    return NextResponse.json({ received: false }, { status: 202 });
  }

  return NextResponse.json({ received: true }, { status: 202 });
}
