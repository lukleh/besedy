import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { badRequest, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { TimestampIdSchema } from "@/lib/validation/schemas";
import {
  INTAKE_INCLUDE,
  reconcileActiveIntakes,
  serializeIntake,
} from "@/lib/ingest/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ListQuerySchema = z.object({
  catalogId: TimestampIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

/**
 * GET /api/admin/ingest?catalogId=&limit=
 * Lists recording intakes across catalogs (newest first) with live Prefect
 * state overlaid on queued/running rows.
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const parsed = ListQuerySchema.safeParse(
      Object.fromEntries(request.nextUrl.searchParams.entries())
    );
    if (!parsed.success) {
      return badRequest(parsed.error.issues[0]?.message || "Invalid query");
    }
    const { catalogId, limit } = parsed.data;

    const rows = await prisma.recordingIntake.findMany({
      where: catalogId ? { workflowGroupId: catalogId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: INTAKE_INCLUDE,
    });

    const reconciled = await reconcileActiveIntakes(rows);
    return NextResponse.json({
      intakes: reconciled.map(({ row, prefectStateName }) =>
        serializeIntake(row, { prefectStateName })
      ),
    });
  } catch (error) {
    return handlePrismaError(error, "recording ingest", "fetch");
  }
}
