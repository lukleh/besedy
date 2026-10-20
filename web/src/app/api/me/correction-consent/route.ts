import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validateRequestBody } from "@/lib/api/validation";
import { requireAuth } from "@/lib/auth/permissions";
import {
  acceptContributorTerms,
  CONTRIBUTOR_TERMS,
  getContributorConsent,
} from "@/lib/correction/consent";
import { CorrectionError } from "@/lib/correction/errors";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The client names the terms version it showed, so an acceptance can never be
// recorded against a text the person did not see.
const AcceptSchema = z.object({ termsVersion: z.string().min(1).max(32) }).strict();

/** Whether the signed-in person has accepted the current contributor terms. */
export async function GET() {
  try {
    const userId = await requireAuth();
    return NextResponse.json({ consent: await getContributorConsent(userId) });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}

/** Accept the current contributor terms (ADR 0012). */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireAuth();
    const bodyResult = await validateRequestBody(request, AcceptSchema);
    if (!bodyResult.success) return bodyResult.response;

    if (bodyResult.data.termsVersion !== CONTRIBUTOR_TERMS.version) {
      throw new CorrectionError(
        "REVISION_CONFLICT",
        "The contributor terms have changed; read them again before accepting",
        { termsVersion: CONTRIBUTOR_TERMS.version }
      );
    }
    return NextResponse.json({ consent: await acceptContributorTerms(userId) });
  } catch (error) {
    return handleCorrectionRouteError(error, "create");
  }
}
