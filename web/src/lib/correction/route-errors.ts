import { NextResponse } from "next/server";
import { handlePrismaError } from "@/lib/api";
import { AuthError } from "@/lib/auth/permissions";
import { CorrectionError } from "@/lib/correction/errors";

/**
 * Prisma codes for a transaction that could not finish because of another
 * one: P2028 is the interactive transaction's own timeout, which a long
 * wait on the workspace row runs into, and P2034 a write conflict or
 * deadlock. Both mean "somebody else was writing; try again", which is a
 * conflict, not a server failure.
 */
const CONTENDED_TRANSACTION_CODES = new Set(["P2028", "P2034"]);

function isContendedTransaction(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    CONTENDED_TRANSACTION_CODES.has(String((error as { code: unknown }).code))
  );
}

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
  if (isContendedTransaction(error)) {
    return NextResponse.json(
      {
        error: "Another change to this transcript is being saved or it is being published; try again in a moment",
        code: "WORKSPACE_LOCKED",
      },
      { status: 409 }
    );
  }
  return handlePrismaError(error, "transcript correction", operation);
}
