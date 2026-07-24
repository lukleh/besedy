import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api/errors";
import { validateRequestBody } from "@/lib/api/validation";
import {
  mergeLabsIntoSettings,
  readLabsPreferenceFromSettings,
} from "@/lib/features/labs";

const UpdateLabsSchema = z.object({
  enabled: z.boolean(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/preferences/labs - Get Labs preference for current user.
 */
export async function GET() {
  try {
    const userId = await requireAuth();

    const prefs = await prisma.userPreferences.findUnique({
      where: { userId },
      select: { settings: true },
    });

    return NextResponse.json(readLabsPreferenceFromSettings(prefs?.settings));
  } catch (error) {
    return handlePrismaError(error, "labs preference", "fetch");
  }
}

/**
 * PUT /api/preferences/labs - Update Labs preference for current user.
 *
 * Body: { enabled: boolean }
 * `updatedAt` is always generated server-side.
 */
export async function PUT(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const bodyResult = await validateRequestBody(request, UpdateLabsSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { enabled } = bodyResult.data;

    const existing = await prisma.userPreferences.findUnique({
      where: { userId },
      select: { settings: true },
    });

    const updatedAt = new Date().toISOString();
    const nextSettings = mergeLabsIntoSettings(existing?.settings, enabled, updatedAt);

    const prefs = await prisma.userPreferences.upsert({
      where: { userId },
      update: {
        settings: nextSettings as Prisma.InputJsonValue,
      },
      create: {
        userId,
        settings: nextSettings as Prisma.InputJsonValue,
      },
      select: {
        settings: true,
      },
    });

    return NextResponse.json(readLabsPreferenceFromSettings(prefs.settings));
  } catch (error) {
    return handlePrismaError(error, "labs preference", "update");
  }
}
