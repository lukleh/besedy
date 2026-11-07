import { NextResponse } from "next/server";
import { requireArchive } from "@/lib/archive";
import { requireAuth, AuthError } from "@/lib/auth/permissions";
import { getCatalogCapability } from "@/lib/access/capabilities";
import { handlePrismaError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

/** The archive is selected by deployment configuration, never by a preference. */
export async function GET() {
  try {
    const userId = await requireAuth();
    const archive = await requireArchive();
    const capability = await getCatalogCapability(archive.id, userId);
    if (!capability.hasAccess) {
      throw new AuthError("Archive access required", 403);
    }
    return NextResponse.json(archive);
  } catch (error) {
    return handlePrismaError(error, "archive", "fetch");
  }
}
