import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { SECURE_COOKIE_PREFIX } from "better-auth/cookies";
import { AUTH_COOKIE_PREFIX } from "@/lib/auth/constants";
import { clearAuthCookies } from "@/lib/auth/response-cleanup";

const secureSession = `${SECURE_COOKIE_PREFIX}${AUTH_COOKIE_PREFIX}.session_token`;
const secureData = `${SECURE_COOKIE_PREFIX}${AUTH_COOKIE_PREFIX}.session_data`;
const plainSession = `${AUTH_COOKIE_PREFIX}.session_token`;

function clearWithCookies(cookieHeader: string): string[] {
  const req = new NextRequest("https://example.com/logout", {
    headers: { cookie: cookieHeader },
  });
  const res = NextResponse.json({ ok: true });
  clearAuthCookies(req, res);
  return res.headers.getSetCookie();
}

describe("clearAuthCookies secure-cookie cleanup", () => {
  it("clears __Secure- session cookies with a Secure Set-Cookie so they are actually removed", () => {
    // ResponseCookies.delete() omits the Secure attribute; browsers reject a
    // Set-Cookie for a __Secure- name without it, so the session would survive
    // logout. The fix rewrites them with Secure + an epoch expiry.
    const headers = clearWithCookies(
      [`${secureSession}=abc`, `${secureData}=def`, `${secureData}.0=ghi`].join("; ")
    );

    const sessionClear = headers.find((h) => h.startsWith(`${secureSession}=`));
    expect(sessionClear).toBeDefined();
    expect(sessionClear).toMatch(/Secure/i);
    expect(sessionClear).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    // The chunked secure session_data cookie present on the request is also
    // expired via the Secure path, not a bare delete().
    const dataChunkClear = headers.find((h) => h.startsWith(`${secureData}.0=`));
    expect(dataChunkClear).toBeDefined();
    expect(dataChunkClear).toMatch(/Secure/i);
  });

  it("still clears the non-secure session cookie", () => {
    const headers = clearWithCookies(`${plainSession}=abc`);
    const plainClear = headers.find((h) => h.startsWith(`${plainSession}=`));
    expect(plainClear).toBeDefined();
  });
});
