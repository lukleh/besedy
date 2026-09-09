import { NextRequest, NextResponse } from "next/server";
import { unauthorized } from "@/lib/api/errors";
import { constantTimeEqual } from "@/lib/security/constant-time";

/**
 * Bearer check for service-to-service calls from the jobs runtime (jobs API,
 * Prefect workers). These routes are not browser-facing, so they carry no CSRF
 * origin check; the shared secret is the whole trust boundary.
 */
export function authorizeJobServiceRequest(request: NextRequest): NextResponse | null {
  const secret = process.env.BESEDY_JOB_SERVICE_SECRET?.trim();
  const authHeader = request.headers.get("Authorization");
  if (!secret || authHeader === null || !constantTimeEqual(authHeader, `Bearer ${secret}`)) {
    return unauthorized("Unauthorized");
  }
  return null;
}
