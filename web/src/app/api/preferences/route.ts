import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api/errors";
import { validateRequestBody } from "@/lib/api/validation";

// Schema for preferences update (all fields optional)
const PreferencesUpdateSchema = z.object({
  theme: z.string().optional(),
  catalogColumns: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
}).strict();

const preferencesSelect = {
  userId: true,
  theme: true,
  catalogColumns: true,
  settings: true,
} as const;

export const dynamic = "force-dynamic";

/**
 * GET /api/preferences - Get user preferences
 * Requires authentication.
 */
export async function GET() {
  try {
    const userId = await requireAuth();

    const prefs = await prisma.userPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: preferencesSelect,
    });

    return NextResponse.json(prefs);
  } catch (error) {
    return handlePrismaError(error, "preferences", "fetch");
  }
}

/**
 * PATCH /api/preferences - Update user preferences
 * Requires authentication.
 */
export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const bodyResult = await validateRequestBody(request, PreferencesUpdateSchema);
    if (!bodyResult.success) return bodyResult.response;
    const { theme, catalogColumns, settings } = bodyResult.data;

    const updateData: {
      theme?: string;
      catalogColumns?: string[];
      settings?: object;
    } = {};

    if (theme !== undefined) {
      updateData.theme = theme;
    }
    if (catalogColumns !== undefined) {
      updateData.catalogColumns = catalogColumns;
    }
    if (settings !== undefined) {
      updateData.settings = settings;
    }

    const prefs = await prisma.userPreferences.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        ...updateData,
        theme: updateData.theme ?? "system",
        catalogColumns: updateData.catalogColumns ?? [],
        settings: updateData.settings ?? {},
      },
      select: preferencesSelect,
    });

    return NextResponse.json(prefs);
  } catch (error) {
    return handlePrismaError(error, "preferences", "update");
  }
}
