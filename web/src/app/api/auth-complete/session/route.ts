import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { applyAuthCleanup } from "@/lib/auth/response-cleanup";

export async function GET(req: NextRequest) {
  const authResult = await resolveRequestAuth(req, { surface: "api" });
  const response = NextResponse.json({
    authenticated: authResult.authenticated,
  });

  response.headers.set("Cache-Control", "no-store");
  await applyAuthCleanup(req, response, authResult);

  return response;
}
