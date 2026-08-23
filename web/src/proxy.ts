import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SECURE_COOKIE_PREFIX } from "better-auth/cookies";
import { checkRateLimit } from "./lib/security/rate-limit";
import { constantTimeEqual } from "./lib/security/constant-time";
import {
  resolveRequestAuth,
} from "./lib/auth/request-auth";
import { validateMutationSource } from "./lib/api/csrf";
import { AUTH_COOKIE_PREFIX } from "./lib/auth/constants";
import { applyAuthCleanup } from "./lib/auth/response-cleanup";
import {
  buildAuthCompletePath,
  getAllowlistRejectionParam,
  hasOAuthCallbackResidue,
  sanitizeAppRelativePath,
  sanitizePostAuthCallbackPath,
} from "./lib/auth/oauth-routing";
import { ADMIN_PAGE_REDIRECTS, isAdminPagePath } from "./lib/access/admin-page-access";

/**
 * Format timestamp for access log.
 */
function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace("T", " ").substring(0, 19);
}

/**
 * Get client IP from request headers (Cloudflare/proxy aware).
 */
function getClientIp(req: NextRequest): string {
  return getRequestIp(req);
}

function getDirectClientIp(req: NextRequest): string | null {
  const candidate = (req as NextRequest & { ip?: string }).ip;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getForwardedClientIp(req: NextRequest): string | null {
  return (
    getFirstHeaderValue(req.headers.get("cf-connecting-ip")) ||
    getFirstHeaderValue(req.headers.get("x-forwarded-for")) ||
    getFirstHeaderValue(req.headers.get("x-real-ip"))
  );
}

/**
 * Resolve request IP for observability.
 *
 * For logs we keep a best-effort value even when proxy header trust is disabled.
 */
function getRequestIp(req: NextRequest): string {
  const directIp = getDirectClientIp(req);
  if (directIp) return directIp;
  return getForwardedClientIp(req) || "unknown";
}

function hashFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getRateLimitFallbackKey(req: NextRequest): string {
  const sessionCookieName = `${AUTH_COOKIE_PREFIX}.session_token`;
  const secureSessionCookieName = `${SECURE_COOKIE_PREFIX}${sessionCookieName}`;
  const sessionToken =
    req.cookies.get(sessionCookieName)?.value ??
    req.cookies.get(secureSessionCookieName)?.value ??
    "";

  const seed = [
    sessionToken.slice(0, 32),
    getFirstHeaderValue(req.headers.get("user-agent")) ?? "",
    getFirstHeaderValue(req.headers.get("accept-language")) ?? "",
    getFirstHeaderValue(req.headers.get("sec-ch-ua")) ?? "",
    getFirstHeaderValue(req.headers.get("sec-ch-ua-platform")) ?? "",
    // Untrusted forwarding headers are used only to avoid global "unknown"
    // buckets when direct client IP is unavailable.
    getForwardedClientIp(req) ?? "",
  ]
    .filter((part) => part.length > 0)
    .join("|");

  if (!seed) return "unknown";
  return `fp:${hashFingerprint(seed)}`;
}

/**
 * Resolve stable rate-limit key for the current client.
 *
 * Forwarded headers are only considered authoritative for IP keys when
 * TRUST_PROXY_HEADERS=true.
 */
function getRateLimitClientKey(req: NextRequest): string {
  const directIp = getDirectClientIp(req);
  if (directIp) {
    return `ip:${directIp}`;
  }

  if (TRUST_PROXY_HEADERS) {
    const forwardedIp = getForwardedClientIp(req);
    if (forwardedIp) {
      return `ip:${forwardedIp}`;
    }
  }

  return getRateLimitFallbackKey(req);
}

function isMutationMethod(method: string): boolean {
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

function isAuthorizedInternalDeepSearchRequest(req: NextRequest): boolean {
  if (!req.nextUrl.pathname.startsWith("/api/internal/deep-search/")) {
    return false;
  }

  const expected = process.env.BESEDY_JOB_SERVICE_SECRET?.trim();
  if (!expected) return false;
  const authHeader = req.headers.get("authorization");
  return authHeader !== null && constantTimeEqual(authHeader, `Bearer ${expected}`);
}

// Query params safe to log - everything else gets redacted.
const SAFE_LOG_PARAMS = new Set([
  "page",
  "limit",
  "status",
  "sort",
  "order",
  "group",
  "source",
  "variant",
  "format",
  "download",
  "backend",
  "actionable",
  "verified",
  "artist",
  "album",
]);

/**
 * Redact sensitive query parameters for logging.
 */
function redactQueryParams(searchParams: URLSearchParams): string {
  if (searchParams.size === 0) return "";

  const redacted = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (SAFE_LOG_PARAMS.has(key)) {
      redacted.set(key, value);
    } else {
      redacted.set(key, "[REDACTED]");
    }
  }
  return `?${redacted.toString()}`;
}

type LoggedStatus = number | "pass";

/**
 * Log HTTP request in standard access log format.
 *
 * Pass-through requests use "pass" because middleware cannot see the final
 * downstream status after NextResponse.next().
 */
function logRequest(req: NextRequest, status: LoggedStatus, durationMs: number): void {
  const ip = getClientIp(req);
  const method = req.method;
  const pathname = req.nextUrl.pathname;
  const search = redactQueryParams(req.nextUrl.searchParams);
  const timestamp = formatTimestamp();
  console.log(
    `[${timestamp}] ${method} ${pathname}${search} ${status} ${durationMs}ms ${ip}`
  );
}

// Routes that don't require authentication.
const publicRoutes = [
  "/auth/signin",
  "/auth/complete",
  "/auth/blocked",
  "/auth/pending",
  "/auth/unauthorized",
  "/auth/no-access",
  "/mock-oauth",
  "/robots.txt",
  "/.well-known/security.txt",
];

// Public API routes.
const publicApiRoutes = ["/api/health", "/api/version"];

// Supported locales (must match i18n/routing.ts).
const SUPPORTED_LOCALES = ["en", "cs"] as const;
const DEFAULT_LOCALE = "en";
const LOCALE_COOKIE_NAME = "NEXT_LOCALE";
const LOCALE_COOKIE_MAX_AGE = 31536000; // 1 year in seconds

// Rate limit configuration for auth endpoints.
const AUTH_RATE_LIMIT = 30;
const AUTH_RATE_WINDOW_MS = 60 * 1000;
const CSP_REPORT_RATE_LIMIT = 30;
const CSP_REPORT_RATE_WINDOW_MS = 60 * 1000;

type RuntimeEnv = "development" | "test" | "production";

function getRuntimeEnv(): RuntimeEnv {
  const appEnv = process.env.APP_ENV;
  if (appEnv === "production" || appEnv === "development" || appEnv === "test") {
    return appEnv;
  }
  if (process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

// Disable auth rate limiting in dev/test environments.
const runtimeEnv = getRuntimeEnv();
const isDevelopment = runtimeEnv !== "production";
const isProduction = runtimeEnv === "production";
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === "true";

/**
 * Extract first value from potentially comma-separated header.
 */
function getFirstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  return value.split(",")[0].trim();
}

/**
 * Detect locale from Accept-Language header.
 */
function detectLocaleFromHeader(acceptLanguage: string | null): string {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const languages = acceptLanguage.split(",").map((lang) => {
    const [code] = lang.trim().split(";");
    return code.split("-")[0];
  });

  for (const lang of languages) {
    if (SUPPORTED_LOCALES.includes(lang as (typeof SUPPORTED_LOCALES)[number])) {
      return lang;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Set locale cookie on response if not already set.
 */
function handleLocale(req: NextRequest, response: NextResponse): string {
  const existingLocale = req.cookies.get(LOCALE_COOKIE_NAME)?.value;
  if (
    existingLocale &&
    SUPPORTED_LOCALES.includes(
      existingLocale as (typeof SUPPORTED_LOCALES)[number]
    )
  ) {
    return existingLocale;
  }

  const detectedLocale = detectLocaleFromHeader(
    req.headers.get("accept-language")
  );
  response.cookies.set(LOCALE_COOKIE_NAME, detectedLocale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
    secure: isProduction,
  });

  return detectedLocale;
}

/**
 * Generate a per-request CSP nonce (base64). Uses Web Crypto so it works on
 * both the Edge and Node runtimes.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Build the Content-Security-Policy for a request nonce. script-src uses the
 * nonce + 'strict-dynamic' (no 'unsafe-inline'); 'unsafe-eval' stays dev-only.
 * style-src still allows 'unsafe-inline' (out of scope; framework injects styles).
 */
function buildCsp(nonce: string): string {
  const scriptSrc = isDevelopment
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://www.google.com https://*.googleusercontent.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "report-to csp-endpoint",
    "report-uri /api/csp-report",
  ].join("; ");
}

/**
 * Pass-through response that carries the CSP nonce on the request headers so
 * Next.js applies it to its framework scripts during SSR.
 */
function nextWithNonce(req: NextRequest, nonce: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", buildCsp(nonce));
  return NextResponse.next({ request: { headers } });
}

/**
 * Add security headers to response.
 */
function addSecurityHeaders(
  req: NextRequest,
  response: NextResponse,
  nonce: string
): NextResponse {
  if (!req.nextUrl.pathname.startsWith("/api/")) {
    response.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }

  response.headers.set("X-App-Commit", process.env.GIT_COMMIT ?? "unknown");
  response.headers.set(
    "X-Web-Version",
    process.env.WEB_VERSION ?? process.env.GIT_COMMIT ?? "unknown"
  );
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  const forwardedProto = getFirstHeaderValue(req.headers.get("x-forwarded-proto"));
  const forwardedHost = getFirstHeaderValue(req.headers.get("x-forwarded-host"));
  const protocol = forwardedProto ?? req.nextUrl.protocol.replace(":", "");
  const host = forwardedHost ?? req.headers.get("host") ?? req.nextUrl.host;
  const reportingEndpoint = `${protocol}://${host}/api/csp-report`;
  response.headers.set("Reporting-Endpoints", `csp-endpoint="${reportingEndpoint}"`);
  response.headers.set("Content-Security-Policy", buildCsp(nonce));

  if (isProduction) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }

  return response;
}

export async function proxy(req: NextRequest) {
  const startTime = Date.now();
  const nonce = generateNonce();
  const { pathname } = req.nextUrl;
  const error = req.nextUrl.searchParams.get("error");
  const errorDescription = req.nextUrl.searchParams.get("error_description");
  const state = req.nextUrl.searchParams.get("state");
  const allowlistRejection = getAllowlistRejectionParam(error, errorDescription);
  const callbackUrl = sanitizePostAuthCallbackPath(
    req.nextUrl.searchParams.get("callbackUrl")
  );
  const currentRouteWithQuery = sanitizeAppRelativePath(`${pathname}${req.nextUrl.search}`);

  const logAndReturn = (response: NextResponse, status?: LoggedStatus): NextResponse => {
    const duration = Date.now() - startTime;
    logRequest(req, status ?? response.status, duration);
    return response;
  };

  // Sign-in page: authenticated users are redirected away.
  if (pathname === "/auth/signin") {
    if (allowlistRejection) {
      const response = NextResponse.redirect(
        new URL(
          `/auth/unauthorized?error=${encodeURIComponent(allowlistRejection)}`,
          req.url
        )
      );
      handleLocale(req, response);
      return logAndReturn(addSecurityHeaders(req, response, nonce), 307);
    }

    // Compatibility funnel for older tabs still running the pre-/auth/complete bundle.
    if (hasOAuthCallbackResidue({ error, errorDescription, state })) {
      const response = NextResponse.redirect(
        new URL(
          buildAuthCompletePath(callbackUrl, {
            error,
            errorDescription,
            state,
          }),
          req.url
        )
      );
      handleLocale(req, response);
      return logAndReturn(addSecurityHeaders(req, response, nonce), 307);
    }

    const authResult = await resolveRequestAuth(req, { surface: "middleware" });
    if (authResult.authenticated) {
      const response = NextResponse.redirect(new URL(callbackUrl, req.url));
      handleLocale(req, response);
      return logAndReturn(addSecurityHeaders(req, response, nonce), 307);
    }

    const response = nextWithNonce(req, nonce);
    await applyAuthCleanup(req, response, authResult);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    const response = nextWithNonce(req, nonce);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  if (
    pathname === "/api/csp-report" ||
    pathname.startsWith("/api/csp-report/")
  ) {
    const clientKey = getRateLimitClientKey(req);
    if (
      !isDevelopment &&
      !checkRateLimit(
        `csp-report:${clientKey}`,
        CSP_REPORT_RATE_LIMIT,
        CSP_REPORT_RATE_WINDOW_MS
      )
    ) {
      const response = new NextResponse("Too Many Requests", { status: 429 });
      response.headers.set("Retry-After", "60");
      return logAndReturn(addSecurityHeaders(req, response, nonce), 429);
    }

    const response = nextWithNonce(req, nonce);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  if (publicApiRoutes.some((route) => pathname === route)) {
    const response = nextWithNonce(req, nonce);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  // Allow Better Auth API routes with rate limiting.
  if (pathname.startsWith("/api/auth")) {
    const clientKey = getRateLimitClientKey(req);

    if (
      !isDevelopment &&
      !checkRateLimit(`auth:${clientKey}`, AUTH_RATE_LIMIT, AUTH_RATE_WINDOW_MS)
    ) {
      const response = new NextResponse("Too Many Requests", { status: 429 });
      response.headers.set("Retry-After", "60");
      return logAndReturn(addSecurityHeaders(req, response, nonce), 429);
    }

    const response = nextWithNonce(req, nonce);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  // Non-auth APIs are not redirected by middleware; route handlers return 401/403.
  if (pathname.startsWith("/api/")) {
    if (isMutationMethod(req.method) && !isAuthorizedInternalDeepSearchRequest(req)) {
      const sourceError = validateMutationSource(req);
      if (sourceError) {
        handleLocale(req, sourceError);
        return logAndReturn(addSecurityHeaders(req, sourceError, nonce));
      }
    }

    const response = nextWithNonce(req, nonce);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
  }

  // Protected pages.
  const authResult = await resolveRequestAuth(req, { surface: "middleware" });
  if (!authResult.authenticated) {
    if (isAdminPagePath(pathname)) {
      const response = NextResponse.redirect(
        new URL(ADMIN_PAGE_REDIRECTS.unauthenticatedRedirect, req.url)
      );
      await applyAuthCleanup(req, response, authResult);
      handleLocale(req, response);
      return logAndReturn(addSecurityHeaders(req, response, nonce), 307);
    }

    const signInUrl = new URL("/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", currentRouteWithQuery);
    const response = NextResponse.redirect(signInUrl);
    await applyAuthCleanup(req, response, authResult);
    handleLocale(req, response);
    return logAndReturn(addSecurityHeaders(req, response, nonce), 307);
  }

  const response = nextWithNonce(req, nonce);
  handleLocale(req, response);
  return logAndReturn(addSecurityHeaders(req, response, nonce), "pass");
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
