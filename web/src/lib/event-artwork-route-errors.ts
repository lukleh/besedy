import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api";
import { EventArtworkServiceError } from "@/lib/event-artwork-service";
import { ArtworkAssetError } from "@/lib/event-artwork-storage";

export function handleEventArtworkRouteError(
  error: unknown,
  operation: "fetch" | "create" | "update" | "delete"
): NextResponse {
  if (error instanceof ArtworkAssetError) {
    const status = error.code === "UPLOAD_TOO_LARGE" ? 413 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  if (error instanceof EventArtworkServiceError) {
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
  return handlePrismaError(error, "event artwork", operation);
}
