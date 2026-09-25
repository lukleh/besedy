import { NextResponse } from "next/server";
import { handlePrismaError } from "@/lib/api";
import { AuthError } from "@/lib/auth/permissions";
import { CorrectionError } from "@/lib/correction/errors";

export function handleCorrectionRouteError(
  error: unknown,
  operation: "fetch" | "create" | "update" | "delete"
): NextResponse {
  if (error instanceof CorrectionError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        ...(error.details ? { details: error.details } : {}),
      },
      { status: error.statusCode }
    );
  }
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  return handlePrismaError(error, "transcript correction", operation);
}
