import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeJobServiceRequest } from "@/lib/security/job-service-auth";
import { HashSchema, TimestampIdSchema } from "@/lib/validation/schemas";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";
import {
  buildTrainingExport,
  DEFAULT_TRAINING_EXPORT_POLICY,
} from "@/lib/correction/training-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A share between 0 and 1; an empty or non-numeric value is an error, not 0. */
const FractionSchema = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    const fraction = value.trim() === "" ? Number.NaN : Number(value);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
      ctx.addIssue({ code: "custom", message: "Expected a number between 0 and 1" });
      return z.NEVER;
    }
    return fraction;
  });

const QuerySchema = z.object({
  catalogId: TimestampIdSchema,
  minHeardFraction: FractionSchema,
  /** Limits the export to this recording's workspace, for piecewise fetches */
  audioHash: HashSchema.optional(),
});

/**
 * GET /api/internal/correction/training-export?catalogId=...[&audioHash=...]
 *
 * The corrected chunks of a catalog that may train a model, and the excluded
 * ones with their reasons (ADR 0012). Called by `catalog training-export` on
 * the host, which rebuilds each chunk's audio from the frozen source and the
 * staged WAV; the job-service secret authorizes it, as for the other host calls.
 */
export async function GET(request: NextRequest) {
  try {
    const authError = authorizeJobServiceRequest(request);
    if (authError) return authError;

    const query = QuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!query.success) {
      return NextResponse.json({ error: "Invalid query", issues: query.error.issues }, { status: 400 });
    }

    return NextResponse.json(
      await buildTrainingExport(
        query.data.catalogId,
        {
          minHeardFraction: query.data.minHeardFraction ?? DEFAULT_TRAINING_EXPORT_POLICY.minHeardFraction,
        },
        { audioHash: query.data.audioHash }
      )
    );
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
