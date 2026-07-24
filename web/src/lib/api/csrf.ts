import { NextRequest, NextResponse } from "next/server";
import { ApiErrorCode, apiError } from "./errors";
import { getAuthTrustedOrigins } from "@/lib/runtime-config";

interface MutationSourceValidationOptions {
  allowMissingSource?: boolean;
  trustedOrigins?: string[];
}

function shouldAllowMissingSourceByDefault(): boolean {
  return process.env.APP_ENV === "test";
}

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getAllowedOrigins(
  request: NextRequest,
  trustedOrigins: string[] = []
): Set<string> {
  const requestOrigin = normalizeOrigin(request.url);
  const configuredOrigins = getAuthTrustedOrigins();
  const allowedOrigins = [
    requestOrigin,
    ...configuredOrigins.map((origin) => normalizeOrigin(origin)),
    ...trustedOrigins.map((origin) => normalizeOrigin(origin)),
  ].filter((origin): origin is string => Boolean(origin));

  return new Set(allowedOrigins);
}

function getRequestSourceOrigin(request: NextRequest): string | null {
  return (
    normalizeOrigin(request.headers.get("origin")) ??
    normalizeOrigin(request.headers.get("referer"))
  );
}

export function validateMutationSource(
  request: NextRequest,
  options: MutationSourceValidationOptions = {}
): NextResponse | null {
  const allowMissingSource =
    options.allowMissingSource ?? shouldAllowMissingSourceByDefault();
  const sourceOrigin = getRequestSourceOrigin(request);
  if (!sourceOrigin) {
    // Playwright's APIRequestContext does not synthesize browser-managed
    // Origin/Referer headers, so test-environment mutations need an explicit
    // escape hatch to keep exercising the real auth/authorization path.
    if (allowMissingSource) {
      return null;
    }

    return apiError(
      "Invalid request origin",
      403,
      ApiErrorCode.FORBIDDEN
    );
  }

  const allowedOrigins = getAllowedOrigins(request, options.trustedOrigins);
  if (allowedOrigins.has(sourceOrigin)) {
    return null;
  }

  return apiError(
    "Invalid request origin",
    403,
    ApiErrorCode.FORBIDDEN
  );
}
