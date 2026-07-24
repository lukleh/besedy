import { NextRequest, NextResponse } from "next/server";
import { z, ZodError, ZodSchema } from "zod";
import { badRequest, ApiErrorResponse } from "./errors";

/**
 * Result type for validation functions.
 * Enables clean early returns without try-catch.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; response: NextResponse<ApiErrorResponse> };

/**
 * Validate request body against a Zod schema.
 *
 * @example
 * const result = await validateRequestBody(request, CreateEnumSchema);
 * if (!result.success) return result.response;
 * const { name } = result.data;
 */
export async function validateRequestBody<T extends ZodSchema>(
  request: NextRequest,
  schema: T
): Promise<ValidationResult<z.infer<T>>> {
  try {
    const rawBody = await request.json();
    const data = schema.parse(rawBody);
    return { success: true, data };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        success: false,
        response: badRequest("Invalid request body", error.flatten()),
      };
    }
    if (error instanceof SyntaxError) {
      return {
        success: false,
        response: badRequest("Invalid JSON in request body"),
      };
    }
    throw error;
  }
}

/**
 * Validate route params against a schema.
 *
 * @example
 * const result = validateParams(await params, IntIdParamSchema);
 * if (!result.success) return result.response;
 * const { id } = result.data;
 */
export function validateParams<T extends ZodSchema>(
  params: Record<string, string>,
  schema: T
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(params);
  if (!result.success) {
    return {
      success: false,
      response: badRequest("Invalid route parameters", result.error.flatten()),
    };
  }
  return { success: true, data: result.data };
}

/**
 * Validate search params against a schema.
 *
 * @example
 * const result = validateSearchParams(request.nextUrl.searchParams, PaginationSchema);
 * if (!result.success) return result.response;
 * const { page, limit } = result.data;
 */
export function validateSearchParams<T extends ZodSchema>(
  searchParams: URLSearchParams,
  schema: T
): ValidationResult<z.infer<T>> {
  const params: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    return {
      success: false,
      response: badRequest("Invalid query parameters", result.error.flatten()),
    };
  }
  return { success: true, data: result.data };
}

/**
 * Integer ID schema for auto-increment database IDs.
 * Transforms string to number.
 */
export const IntIdSchema = z.string().transform((val, ctx) => {
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid ID format",
    });
    return z.NEVER;
  }
  return parsed;
});

/**
 * Common param schema for routes with integer ID.
 */
export const IntIdParamSchema = z.object({ id: IntIdSchema });
