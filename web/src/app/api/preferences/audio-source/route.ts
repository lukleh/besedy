import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { AuthError, requireAuth } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AudioSourcePreferences {
  [hash: string]: string; // hash -> sourceId
}

/**
 * GET /api/preferences/audio-source - Get audio source preferences
 *
 * Query params:
 * - hash (optional): Get preference for specific hash
 * - group (optional): Catalog ID to scope the hash
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const hash = searchParams.get("hash");
    const group = searchParams.get("group");

    const userId = await requireAuth();

    const prefs = await prisma.userPreferences.findUnique({
      where: { userId },
    });

    const settings = (prefs?.settings as Record<string, unknown>) || {};
    const audioSources = (settings.audioSources as AudioSourcePreferences) || {};

    if (hash) {
      const scopedKey = group ? `${group}:${hash}` : hash;
      const sourceId = audioSources[scopedKey] ?? audioSources[hash] ?? null;
      return NextResponse.json({
        hash,
        sourceId,
      });
    }

    return NextResponse.json({
      audioSources,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error fetching audio source preferences:", error);
    return NextResponse.json(
      { error: "Failed to fetch preferences" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/preferences/audio-source - Save audio source preference
 *
 * Body: { hash: string, sourceId: string, group: string }
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { hash, sourceId, group } = body;

    const userId = await requireAuth();

    if (!hash || typeof hash !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid hash" },
        { status: 400 }
      );
    }

    if (!sourceId || typeof sourceId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid sourceId" },
        { status: 400 }
      );
    }
    if (!group || typeof group !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid group" },
        { status: 400 }
      );
    }

    // Get current preferences
    const prefs = await prisma.userPreferences.findUnique({
      where: { userId },
    });

    const settings = (prefs?.settings as Record<string, unknown>) || {};
    const audioSources = (settings.audioSources as AudioSourcePreferences) || {};

    // Update the preference for this hash (scoped to catalog)
    const scopedKey = `${group}:${hash}`;
    audioSources[scopedKey] = sourceId;

    // Keep only last 100 entries (ordered by insertion, most recent last)
    const entries = Object.entries(audioSources);
    const trimmed = entries.length > 100
      ? Object.fromEntries(entries.slice(-100))
      : audioSources;

    // Upsert preferences
    await prisma.userPreferences.upsert({
      where: { userId },
      update: {
        settings: {
          ...settings,
          audioSources: trimmed,
        },
      },
      create: {
        userId,
        settings: {
          audioSources: trimmed,
        },
      },
    });

    return NextResponse.json({
      hash,
      sourceId,
      saved: true,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error saving audio source preference:", error);
    return NextResponse.json(
      { error: "Failed to save preference" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/preferences/audio-source - Delete audio source preference
 *
 * Query params:
 * - hash: Hash to delete preference for
 * - group: Catalog ID to scope the hash
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const hash = searchParams.get("hash");
    const group = searchParams.get("group");

    const userId = await requireAuth();

    if (!hash) {
      return NextResponse.json(
        { error: "Missing hash parameter" },
        { status: 400 }
      );
    }
    if (!group) {
      return NextResponse.json(
        { error: "Missing group parameter" },
        { status: 400 }
      );
    }

    const prefs = await prisma.userPreferences.findUnique({
      where: { userId },
    });

    if (!prefs) {
      return NextResponse.json({ deleted: false });
    }

    const settings = (prefs.settings as Record<string, unknown>) || {};
    const audioSources = (settings.audioSources as AudioSourcePreferences) || {};

    const scopedKey = `${group}:${hash}`;
    if (scopedKey in audioSources) {
      delete audioSources[scopedKey];

      await prisma.userPreferences.update({
        where: { userId },
        data: {
          settings: {
            ...settings,
            audioSources,
          },
        },
      });

      return NextResponse.json({ deleted: true });
    }

    return NextResponse.json({ deleted: false });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error deleting audio source preference:", error);
    return NextResponse.json(
      { error: "Failed to delete preference" },
      { status: 500 }
    );
  }
}
