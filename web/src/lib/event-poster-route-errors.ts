import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api";
import { EventPosterServiceError } from "@/lib/event-poster-service";
import { PosterAssetError } from "@/lib/event-poster-storage";

export function handleEventPosterRouteError(
  error: unknown,
  operation: "fetch" | "create" | "update" | "delete"
): NextResponse {
  if (error instanceof PosterAssetError) {
    const status = error.code === "UPLOAD_TOO_LARGE" ? 413 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof EventPosterServiceError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.statusCode === 404 ? "NOT_FOUND" : "CONFLICT",
      },
      { status: error.statusCode }
    );
  }
  if (error instanceof AuthError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  return handlePrismaError(error, "event poster", operation);
}
