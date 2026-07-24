import { SECURE_COOKIE_PREFIX } from "better-auth/cookies";
import type { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_PREFIX } from "./constants";
import {
  invalidateSessionById,
  type RequestAuthResult,
} from "./request-auth";

function expireSecureCookie(response: NextResponse, name: string): void {
  // "__Secure-" cookies can only be overwritten by a Set-Cookie carrying the
  // Secure attribute, which ResponseCookies.delete() omits. Attributes match
  // the better-auth defaults used when these cookies are created.
  response.cookies.set(name, "", {
    expires: new Date(0),
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  });
}

export function clearAuthCookies(req: NextRequest, response: NextResponse): void {
  const sessionCookieName = `${AUTH_COOKIE_PREFIX}.session_token`;
  const secureSessionCookieName = `${SECURE_COOKIE_PREFIX}${sessionCookieName}`;
  response.cookies.delete(sessionCookieName);
  expireSecureCookie(response, secureSessionCookieName);
  response.cookies.delete(`${sessionCookieName}.sig`);
  expireSecureCookie(response, `${secureSessionCookieName}.sig`);

  const sessionDataCookieName = `${AUTH_COOKIE_PREFIX}.session_data`;
  const secureSessionDataCookieName = `${SECURE_COOKIE_PREFIX}${sessionDataCookieName}`;
  response.cookies.delete(sessionDataCookieName);
  expireSecureCookie(response, secureSessionDataCookieName);
  for (const cookie of req.cookies.getAll()) {
    if (cookie.name.startsWith(`${sessionDataCookieName}.`)) {
      response.cookies.delete(cookie.name);
    }
    if (cookie.name.startsWith(`${secureSessionDataCookieName}.`)) {
      expireSecureCookie(response, cookie.name);
    }
  }
}

export async function applyAuthCleanup(
  req: NextRequest,
  response: NextResponse,
  authResult: RequestAuthResult
): Promise<void> {
  if (authResult.shouldInvalidateSession && authResult.sessionId) {
    await invalidateSessionById(authResult.sessionId);
  }
  if (authResult.shouldClearCookies) {
    clearAuthCookies(req, response);
  }
}
