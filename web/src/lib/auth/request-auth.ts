import { SECURE_COOKIE_PREFIX } from "better-auth/cookies";
import { auth } from "@/lib/auth";
import prisma from "@/lib/db";
import { createServerLogger } from "@/lib/log/server";
import { AUTH_COOKIE_PREFIX } from "./constants";
import {
  recordRequestAuthDecision,
  type AuthResolverSurface,
} from "./request-auth-observability";

type ResolvedUserStatus = "ACTIVE" | "PENDING" | "BLOCKED" | null;

export const RequestAuthReason = {
  AUTHENTICATED: "authenticated",
  NO_SESSION_COOKIE: "no_session_cookie",
  SESSION_NOT_FOUND: "session_not_found",
  SESSION_EXPIRED: "session_expired",
  SESSION_USER_MISSING: "session_user_missing",
  USER_NOT_ACTIVE: "user_not_active",
  INTERNAL_ERROR: "internal_error",
} as const;

export type RequestAuthReason =
  (typeof RequestAuthReason)[keyof typeof RequestAuthReason];

export interface RequestAuthResult {
  authenticated: boolean;
  reason: RequestAuthReason;
  userId: string | null;
  sessionId: string | null;
  sessionToken: string | null;
  sessionExpiresAt: Date | null;
  userEmail: string | null;
  userName: string | null;
  userImage: string | null;
  userEmailVerified: boolean;
  userStatus: ResolvedUserStatus;
  shouldClearCookies: boolean;
  shouldInvalidateSession: boolean;
}

export interface ResolveRequestAuthOptions {
  surface?: AuthResolverSurface;
}

type SessionCookiePair = {
  plain: string | null;
  secure: string | null;
};

type SessionCookieVariant = "plain" | "secure";

type SelectedSessionCookie = {
  reason: RequestAuthReason;
  value: string | null;
  variant: SessionCookieVariant | null;
};

const logger = createServerLogger("request-auth");

function unauthenticated(
  reason: RequestAuthReason,
  overrides?: Partial<RequestAuthResult>
): RequestAuthResult {
  return {
    authenticated: false,
    reason,
    userId: null,
    sessionId: null,
    sessionToken: null,
    sessionExpiresAt: null,
    userEmail: null,
    userName: null,
    userImage: null,
    userEmailVerified: false,
    userStatus: null,
    shouldClearCookies: false,
    shouldInvalidateSession: false,
    ...overrides,
  };
}

function getRequestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "unknown";
  }
}

function finalizeResult(
  result: RequestAuthResult,
  request: Request,
  options?: ResolveRequestAuthOptions
): RequestAuthResult {
  recordRequestAuthDecision(result, {
    surface: options?.surface ?? "unknown",
    path: getRequestPath(request.url),
    method: request.method || "GET",
  });
  return result;
}

function isProductionEnv(): boolean {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production" || appEnv === "development" || appEnv === "test") {
    return appEnv === "production";
  }
  return process.env.NODE_ENV === "production";
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const parsed = new Map<string, string>();
  if (!cookieHeader) return parsed;

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const separatorPos = trimmed.indexOf("=");
    if (separatorPos <= 0) continue;

    const name = trimmed.slice(0, separatorPos).trim();
    if (!name) continue;

    parsed.set(name, trimmed.slice(separatorPos + 1));
  }

  return parsed;
}

function getSessionCookiePair(request: Request): SessionCookiePair {
  const cookieName = `${AUTH_COOKIE_PREFIX}.session_token`;
  const secureCookieName = `${SECURE_COOKIE_PREFIX}${cookieName}`;
  const parsed = parseCookieHeader(request.headers.get("cookie"));

  return {
    plain: parsed.get(cookieName) ?? null,
    secure: parsed.get(secureCookieName) ?? null,
  };
}

function selectSessionCookie(
  pair: SessionCookiePair
): SelectedSessionCookie {
  if (isProductionEnv()) {
    if (pair.secure) {
      return {
        value: pair.secure,
        variant: "secure",
        reason: RequestAuthReason.AUTHENTICATED,
      };
    }
    return {
      value: null,
      variant: null,
      reason: RequestAuthReason.NO_SESSION_COOKIE,
    };
  }

  if (pair.plain) {
    return {
      value: pair.plain,
      variant: "plain",
      reason: RequestAuthReason.AUTHENTICATED,
    };
  }

  if (pair.secure) {
    return {
      value: pair.secure,
      variant: "secure",
      reason: RequestAuthReason.AUTHENTICATED,
    };
  }

  return {
    value: null,
    variant: null,
    reason: RequestAuthReason.NO_SESSION_COOKIE,
  };
}

function getCookieNamespace(variant: SessionCookieVariant) {
  const prefix = variant === "secure" ? SECURE_COOKIE_PREFIX : "";
  const sessionTokenName = `${prefix}${AUTH_COOKIE_PREFIX}.session_token`;
  const sessionDataName = `${prefix}${AUTH_COOKIE_PREFIX}.session_data`;

  return {
    sessionTokenName,
    sessionDataName,
  };
}

function isNamespacedAuthCookie(
  name: string,
  variant: SessionCookieVariant
): boolean {
  const { sessionTokenName, sessionDataName } = getCookieNamespace(variant);
  return (
    name === sessionTokenName ||
    name === `${sessionTokenName}.sig` ||
    name === sessionDataName ||
    name.startsWith(`${sessionDataName}.`)
  );
}

function isAuthCookie(name: string): boolean {
  return (
    isNamespacedAuthCookie(name, "plain") ||
    isNamespacedAuthCookie(name, "secure")
  );
}

function buildHeadersForSelectedSession(
  request: Request,
  variant: SessionCookieVariant
): Headers {
  const parsedCookies = parseCookieHeader(request.headers.get("cookie"));
  const filteredCookies = Array.from(parsedCookies.entries()).filter(([name]) => {
    if (!isAuthCookie(name)) {
      return true;
    }

    return isNamespacedAuthCookie(name, variant);
  });

  const headers = new Headers(request.headers);
  if (filteredCookies.length === 0) {
    headers.delete("cookie");
    return headers;
  }

  headers.set(
    "cookie",
    filteredCookies.map(([name, value]) => `${name}=${value}`).join("; ")
  );
  return headers;
}

type BetterAuthSessionResponse = Awaited<ReturnType<typeof auth.api.getSession>>;

function normalizeDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildAuthenticatedResult(
  sessionData: NonNullable<BetterAuthSessionResponse>
): RequestAuthResult {
  const sessionExpiresAt = normalizeDate(sessionData.session.expiresAt);
  return {
    authenticated: true,
    reason: RequestAuthReason.AUTHENTICATED,
    userId: sessionData.user.id,
    sessionId: sessionData.session.id,
    sessionToken: sessionData.session.token,
    sessionExpiresAt,
    userEmail: sessionData.user.email,
    userName:
      typeof sessionData.user.name === "string" ? sessionData.user.name : null,
    userImage:
      typeof sessionData.user.image === "string" ? sessionData.user.image : null,
    userEmailVerified: sessionData.user.emailVerified,
    userStatus: "ACTIVE",
    shouldClearCookies: false,
    shouldInvalidateSession: false,
  };
}

/**
 * Resolve authentication state for an incoming request.
 *
 * Canonical contract:
 * - authenticated only when session is valid and user status is ACTIVE
 * - PENDING/BLOCKED are treated as signed-out
 */
export async function resolveRequestAuth(
  request: Request,
  options?: ResolveRequestAuthOptions
): Promise<RequestAuthResult> {
  const finalize = (result: RequestAuthResult): RequestAuthResult =>
    finalizeResult(result, request, options);
  const pair = getSessionCookiePair(request);
  const selectedCookie = selectSessionCookie(pair);

  if (!selectedCookie.value || !selectedCookie.variant) {
    return finalize(unauthenticated(selectedCookie.reason));
  }

  try {
    const sessionData = await auth.api.getSession({
      headers: buildHeadersForSelectedSession(request, selectedCookie.variant),
      query: {
        disableCookieCache: true,
        disableRefresh: true,
      },
    });

    if (!sessionData) {
      return finalize(
        unauthenticated(RequestAuthReason.SESSION_NOT_FOUND, {
          shouldClearCookies: true,
        })
      );
    }

    const sessionExpiresAt = normalizeDate(sessionData.session.expiresAt);
    if (!sessionExpiresAt) {
      return finalize(
        unauthenticated(RequestAuthReason.INTERNAL_ERROR, {
          sessionId: sessionData.session.id,
          shouldClearCookies: true,
        })
      );
    }

    if (sessionExpiresAt <= new Date()) {
      return finalize(
        unauthenticated(RequestAuthReason.SESSION_EXPIRED, {
          sessionId: sessionData.session.id,
          sessionToken: sessionData.session.token,
          sessionExpiresAt,
          shouldClearCookies: true,
          shouldInvalidateSession: true,
        })
      );
    }

    if (!sessionData.user?.id) {
      return finalize(
        unauthenticated(RequestAuthReason.SESSION_USER_MISSING, {
          sessionId: sessionData.session.id,
          sessionToken: sessionData.session.token,
          shouldClearCookies: true,
          shouldInvalidateSession: true,
        })
      );
    }

    const userStatus =
      typeof sessionData.user.status === "string"
        ? (sessionData.user.status as ResolvedUserStatus)
        : null;
    if (userStatus !== "ACTIVE") {
      return finalize(
        unauthenticated(RequestAuthReason.USER_NOT_ACTIVE, {
          sessionId: sessionData.session.id,
          sessionToken: sessionData.session.token,
          userId: sessionData.user.id,
          sessionExpiresAt,
          userEmail: sessionData.user.email ?? null,
          userName:
            typeof sessionData.user.name === "string"
              ? sessionData.user.name
              : null,
          userImage:
            typeof sessionData.user.image === "string"
              ? sessionData.user.image
              : null,
          userEmailVerified: sessionData.user.emailVerified,
          userStatus,
          shouldClearCookies: true,
          shouldInvalidateSession: true,
        })
      );
    }

    return finalize(buildAuthenticatedResult(sessionData));
  } catch (error) {
    logger.warn("Better Auth session resolution failed", {
      surface: options?.surface ?? "unknown",
      path: getRequestPath(request.url),
      method: request.method || "GET",
      error,
    });
    return finalize(unauthenticated(RequestAuthReason.INTERNAL_ERROR));
  }
}

export async function resolveRequestAuthFromHeaders(
  requestHeaders: Headers,
  options?: ResolveRequestAuthOptions
): Promise<RequestAuthResult> {
  const request = new Request("http://localhost/internal-auth-check", {
    headers: requestHeaders,
  });
  return resolveRequestAuth(request, options);
}

export async function invalidateSessionById(sessionId: string): Promise<void> {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}
