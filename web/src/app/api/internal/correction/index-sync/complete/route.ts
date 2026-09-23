import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateRequestBody } from "@/lib/api";
import { authorizeJobServiceRequest } from "@/lib/security/job-service-auth";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";
import { completeIndexSync } from "@/lib/correction/publication-service";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CompletionSchema = z
  .object({
    catalogId: TimestampIdSchema,
    audioHash: HashSchema,
    operation: z.enum(["publish", "withdraw", "rollback"]),
    operationToken: z.string().uuid(),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    transcriptFingerprint: z.string().trim().max(128).nullable().optional(),
    transcriptPath: z.string().trim().max(4096).nullable().optional(),
    indexDir: z.string().trim().max(4096).nullable().optional(),
    errorCode: z.string().trim().max(100).nullable().optional(),
    errorMessage: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

/**
 * POST /api/internal/correction/index-sync/complete
 *
 * Called by the host worker once the ColBERT sync for one recording has run.
 * The body says what the active bundle now holds for that recording; the
 * publication service decides whether that is what the operation was meant to
 * leave there and moves the database pointers only then (ADR 0006). The route
 * is idempotent: a report for a state that has already moved on is ignored.
 */
export async function POST(request: NextRequest) {
  try {
    const authError = authorizeJobServiceRequest(request);
    if (authError) return authError;

    const bodyResult = await validateRequestBody(request, CompletionSchema);
    if (!bodyResult.success) return bodyResult.response;

    const result = await completeIndexSync(bodyResult.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return handleCorrectionRouteError(error, "update");
  }
}
