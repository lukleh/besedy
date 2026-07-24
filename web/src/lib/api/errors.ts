import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/permissions";

/**
 * API error codes for machine-readable error handling.
 */
export const ApiErrorCode = {
  VALIDATION: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/**
 * API error response structure.
 */
export interface ApiErrorResponse {
  error: string;
  code?: ApiErrorCode;
  details?: unknown;
}

/**
 * Type guard for Prisma errors.
 */
export function isPrismaError(
  error: unknown
): error is { code: string; meta?: Record<string, unknown> } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  );
}

/**
 * Prisma error code configuration.
 */
interface PrismaErrorConfig {
  status: number;
  code: ApiErrorCode;
}

const PRISMA_ERROR_MAP: Record<string, PrismaErrorConfig> = {
  P2002: { status: 409, code: ApiErrorCode.CONFLICT },
  P2025: { status: 404, code: ApiErrorCode.NOT_FOUND },
  P2003: { status: 400, code: ApiErrorCode.VALIDATION },
  P2014: { status: 400, code: ApiErrorCode.VALIDATION },
};

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Handle API errors and return appropriate NextResponse.
 *
 * Handles AuthError, Prisma errors, and generic errors.
 *
 * @param error - The caught error
 * @param resourceName - Human-readable resource name (e.g., "recorder", "location")
 * @param operation - Operation name for fallback message
 *
 * @example
 * try {
 *   await requireAuth();
 *   await prisma.recorder.create({ data: { name } });
 * } catch (error) {
 *   return handlePrismaError(error, "recorder", "create");
 * }
 */
export function handlePrismaError(
  error: unknown,
  resourceName: string,
  operation: "fetch" | "create" | "update" | "delete" | "revoke" | "restore"
): NextResponse<ApiErrorResponse> {
  // Handle auth errors first
  if (error instanceof AuthError) {
    const code = error.statusCode === 401 ? ApiErrorCode.UNAUTHORIZED : ApiErrorCode.FORBIDDEN;
    return NextResponse.json(
      { error: error.message, code },
      { status: error.statusCode }
    );
  }

  if (isPrismaError(error)) {
    const deleteReferenceConflict = error.code === "P2003" && operation === "delete";
    const config = deleteReferenceConflict
      ? { status: 409, code: ApiErrorCode.CONFLICT }
      : PRISMA_ERROR_MAP[error.code];
    if (config) {
      let message: string;
      if (error.code === "P2002") {
        message = `A ${resourceName} with this name already exists`;
      } else if (error.code === "P2025") {
        message = `${capitalize(resourceName)} not found`;
      } else if (deleteReferenceConflict) {
        message = `Cannot delete ${resourceName}: it is referenced by existing records`;
      } else if (error.code === "P2003") {
        message = "Related record not found (foreign key constraint)";
      } else {
        message = "The change would violate a required relation";
      }

      return NextResponse.json(
        { error: message, code: config.code },
        { status: config.status }
      );
    }
  }

  // Handle known business logic errors (thrown as plain Error)
  if (error instanceof Error) {
    const knownConflictMessages = [
      "A pending portal admission already exists for this email",
      "A user with this email is already active",
      "User already has access to this catalog",
    ];
    const knownBadRequestMessages = [
      "Can only revoke pending admissions",
      "Invalid pending admission",
    ];
    const knownNotFoundMessages = [
      "Portal admission not found",
    ];

    if (knownConflictMessages.some(msg => error.message.includes(msg))) {
      return NextResponse.json(
        { error: error.message, code: ApiErrorCode.CONFLICT },
        { status: 409 }
      );
    }
    if (knownBadRequestMessages.some(msg => error.message.includes(msg))) {
      return NextResponse.json(
        { error: error.message, code: ApiErrorCode.VALIDATION },
        { status: 400 }
      );
    }
    if (knownNotFoundMessages.some(msg => error.message.includes(msg))) {
      return NextResponse.json(
        { error: error.message, code: ApiErrorCode.NOT_FOUND },
        { status: 404 }
      );
    }
  }

  // Log unexpected errors
  const opVerb = operation === "revoke" ? "revoking" : operation === "restore" ? "restoring" : `${operation}ing`;
  console.error(`Error ${opVerb} ${resourceName}:`, error);

  return NextResponse.json(
    {
      error: `Failed to ${operation} ${resourceName}`,
      code: ApiErrorCode.INTERNAL,
    },
    { status: 500 }
  );
}

/**
 * Create a custom API error response.
 */
export function apiError(
  message: string,
  status: number,
  code?: ApiErrorCode,
  details?: unknown
): NextResponse<ApiErrorResponse> {
  const body: ApiErrorResponse = { error: message };
  if (code) body.code = code;
  if (details !== undefined) body.details = details;
  return NextResponse.json(body, { status });
}

/**
 * 404 Not Found response.
 */
export function notFound(resource: string): NextResponse<ApiErrorResponse> {
  return apiError(
    `${capitalize(resource)} not found`,
    404,
    ApiErrorCode.NOT_FOUND
  );
}

/**
 * 409 Conflict response.
 */
export function conflict(message: string): NextResponse<ApiErrorResponse> {
  return apiError(message, 409, ApiErrorCode.CONFLICT);
}

/**
 * 400 Bad Request response.
 */
export function badRequest(
  message: string,
  details?: unknown
): NextResponse<ApiErrorResponse> {
  return apiError(message, 400, ApiErrorCode.VALIDATION, details);
}

/**
 * 403 Forbidden response.
 */
export function forbidden(
  message = "Access denied"
): NextResponse<ApiErrorResponse> {
  return apiError(message, 403, ApiErrorCode.FORBIDDEN);
}

/**
 * 401 Unauthorized response.
 */
export function unauthorized(
  message = "Authentication required"
): NextResponse<ApiErrorResponse> {
  return apiError(message, 401, ApiErrorCode.UNAUTHORIZED);
}

/**
 * 500 Internal Server Error response.
 */
export function internalError(
  message = "Internal server error"
): NextResponse<ApiErrorResponse> {
  return apiError(message, 500, ApiErrorCode.INTERNAL);
}
