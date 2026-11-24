import { NextResponse } from "next/server";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { requireArchive } from "@/lib/archive";
import { loadCorrectionAdminOverview } from "@/lib/correction/admin-overview";
import { handleCorrectionRouteError } from "@/lib/correction/route-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET - correction across the catalog for administrators: every recording's
 * progress, who is working where, whose work waits for a second person and
 * which spans are disputed.
 *
 * It names people and what each has done, so it is an admin page rather than
 * something everyone who corrects can read.
 */
export async function GET() {
  try {
    const { userId } = await requireAdminCapability();
    const archive = await requireArchive();

    const overview = await loadCorrectionAdminOverview({
      catalogId: archive.id,
      actorKey: userId,
      canSeeUnreleased: true,
    });

    return NextResponse.json({ catalogId: archive.id, ...overview });
  } catch (error) {
    return handleCorrectionRouteError(error, "fetch");
  }
}
