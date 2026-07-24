import type { RequestAuthReason, RequestAuthResult } from "./request-auth";
import { createServerLogger } from "@/lib/log/server";

export type AuthResolverSurface = "middleware" | "api" | "server" | "unknown";

export interface RequestAuthLogContext {
  surface?: AuthResolverSurface;
  path?: string;
  method?: string;
}

type AuthReasonLogLevel = "none" | "errors" | "all";

interface AuthRedesignRuntimeConfig {
  reasonLogLevel: AuthReasonLogLevel;
  metricsEnabled: boolean;
  metricsWindowMs: number;
}

const DEFAULT_METRICS_WINDOW_MS = 5 * 60 * 1000;
const reasonCounters = new Map<RequestAuthReason, number>();
let metricsWindowStartedAt = Date.now();
let startupConfigLogged = false;
const logger = createServerLogger();

function isTestEnv(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production" || appEnv === "development" || appEnv === "test") {
    return appEnv === "test";
  }
  return false;
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return defaultValue;
}

function parseReasonLogLevel(raw: string | undefined): AuthReasonLogLevel {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "all" || normalized === "errors" || normalized === "none") {
    return normalized;
  }

  if (isTestEnv()) return "none";
  return "errors";
}

function parseMetricsWindowMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_METRICS_WINDOW_MS;
  return parsed * 1000;
}

function getRuntimeConfig(): AuthRedesignRuntimeConfig {
  return {
    reasonLogLevel: parseReasonLogLevel(
      process.env.AUTH_REDESIGN_REASON_LOG_LEVEL
    ),
    metricsEnabled: parseBooleanEnv(
      process.env.AUTH_REDESIGN_METRICS_ENABLED,
      true
    ),
    metricsWindowMs: parseMetricsWindowMs(
      process.env.AUTH_REDESIGN_METRICS_WINDOW_SECONDS
    ),
  };
}

function getCountersSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = {};
  for (const [reason, count] of reasonCounters.entries()) {
    snapshot[reason] = count;
  }
  return snapshot;
}

function logStartupConfigOnce(config: AuthRedesignRuntimeConfig): void {
  if (startupConfigLogged || isTestEnv()) return;
  startupConfigLogged = true;

  const payload = {
    event: "auth_redesign_config",
    reasonLogLevel: config.reasonLogLevel,
    metricsEnabled: config.metricsEnabled,
    metricsWindowSeconds: Math.floor(config.metricsWindowMs / 1000),
  };

  logger.event("info", { ...payload, level: "info" });
}

function maybeFlushReasonCounters(config: AuthRedesignRuntimeConfig, now: number): void {
  if (!config.metricsEnabled) return;
  if (now - metricsWindowStartedAt < config.metricsWindowMs) return;

  if (!isTestEnv() && reasonCounters.size > 0) {
    logger.event("info", {
      event: "auth_request_reason_metrics",
      windowStartedAt: new Date(metricsWindowStartedAt).toISOString(),
      windowEndedAt: new Date(now).toISOString(),
      counts: getCountersSnapshot(),
    });
  }

  reasonCounters.clear();
  metricsWindowStartedAt = now;
}

function shouldLogDecision(
  config: AuthRedesignRuntimeConfig,
  reason: RequestAuthReason
): boolean {
  if (config.reasonLogLevel === "none") return false;
  if (config.reasonLogLevel === "all") return true;
  return reason !== "authenticated";
}

export function recordRequestAuthDecision(
  result: RequestAuthResult,
  context: RequestAuthLogContext = {}
): void {
  const config = getRuntimeConfig();
  const now = Date.now();

  logStartupConfigOnce(config);
  maybeFlushReasonCounters(config, now);
  reasonCounters.set(result.reason, (reasonCounters.get(result.reason) ?? 0) + 1);

  if (isTestEnv() || !shouldLogDecision(config, result.reason)) return;

  const payload: Record<string, unknown> = {
    event: "auth_request_decision",
    reason: result.reason,
    authenticated: result.authenticated,
    surface: context.surface ?? "unknown",
    method: context.method ?? "GET",
    path: context.path ?? "unknown",
    shouldClearCookies: result.shouldClearCookies,
    shouldInvalidateSession: result.shouldInvalidateSession,
  };

  if (result.userStatus) {
    payload.userStatus = result.userStatus;
  }

  logger.event("info", payload);
}

export function getRequestAuthReasonCounters(): Record<string, number> {
  return getCountersSnapshot();
}
