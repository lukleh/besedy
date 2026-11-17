import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { badRequest, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { requireArchive } from "@/lib/archive";
import { loadEventCreationContext } from "@/lib/catalog-events/create-candidates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  locationId: z.coerce.number().int().positive(),
  dateYear: z.coerce.number().int().min(1900).max(2100),
  dateMonth: z.coerce.number().int().min(1).max(12).optional(),
  dateDay: z.coerce.number().int().min(1).max(31).optional(),
});

/**
 * GET /api/admin/ingest/event-candidates?locationId=&dateYear=&dateMonth=&dateDay=
 * Events that already cover this place and date, the same match that makes an
 * ingest report event_exists, so the upload form can offer them.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });
    const parsed = QuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message || "Invalid query");
    }
    const archive = await requireArchive();
    const { locationId, dateYear, dateMonth, dateDay } = parsed.data;
    const context = await prisma.$transaction((tx) =>
      loadEventCreationContext(tx, {
        workflowGroupId: archive.id,
        locationId,
        dateYear,
        dateMonth: dateMonth ?? null,
        dateDay: dateDay ?? null,
      })
    );
    return NextResponse.json({ candidates: context.candidates });
  } catch (error) {
    return handlePrismaError(error, "event candidates", "fetch");
  }
}
