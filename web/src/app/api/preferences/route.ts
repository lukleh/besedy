import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireAuth } from "@/lib/auth/permissions";
import { handlePrismaError } from "@/lib/api/errors";
import { validateRequestBody } from "@/lib/api/validation";

// Schema for preferences update (all fields optional)
const PreferencesUpdateSchema = z.object({
  activeGroupId: z.string().nullable().optional(),
  theme: z.string().optional(),
  catalogColumns: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

export const dynamic = "force-dynamic";

/**
 * GET /api/preferences - Get user preferences
 * Requires authentication.
 */
export async function GET() {
  try {
    const userId = await requireAuth();

    let prefs = await prisma.userPreferences.findUnique({
      where: { userId },
      include: {
        activeGroup: true,
      },
    });

    // Create default preferences if not exists
    if (!prefs) {
      prefs = await prisma.userPreferences.create({
        data: {
          userId,
          theme: "system",
          catalogColumns: [],
          settings: {},
        },
        include: {
          activeGroup: true,
        },
      });
    }

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
    const { activeGroupId, theme, catalogColumns, settings } = bodyResult.data;

    const updateData: {
      activeGroupId?: string | null;
      theme?: string;
      catalogColumns?: string[];
      settings?: object;
    } = {};

    if (activeGroupId !== undefined) {
      updateData.activeGroupId = activeGroupId;
    }
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
      include: {
        activeGroup: true,
      },
    });

    return NextResponse.json(prefs);
  } catch (error) {
    return handlePrismaError(error, "preferences", "update");
  }
}
