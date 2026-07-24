import { NextRequest, NextResponse } from "next/server";
import {
  getAvailableTranscripts,
  loadTranscript,
  type ASRTranscript,
  type TranscriptBackend,
} from "@/lib/transcript";
import { listTranscriptBackendPriorities } from "@/lib/transcript-priority";
import { AuthError } from "@/lib/auth/permissions";
import { logTranscriptViewed } from "@/lib/audit/logger";
import { resolveTranscriptRouteAccess } from "@/lib/access/transcript-route-access";
import { HashSchema } from "@/lib/validation/schemas";

export const dynamic = "force-dynamic";

interface TranscriptCompareItem {
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

interface TranscriptCompareTrack {
  backend: TranscriptBackend;
  items: TranscriptCompareItem[];
}

interface TranscriptCompareResponse {
  hash: string;
  tracks: TranscriptCompareTrack[];
  duration: number;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function parseText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function toCompareItems(transcript: ASRTranscript): TranscriptCompareItem[] {
  const items: TranscriptCompareItem[] = [];

  for (const segment of transcript.segments) {
    const words = Array.isArray(segment.words) ? segment.words : [];
    if (words.length > 0) {
      for (const word of words) {
        const start = parseTime(word.start);
        const end = parseTime(word.end);
        if (start === null || end === null || end < start) {
          continue;
        }

        const text = parseText((word as { word?: unknown; text?: unknown }).word ?? (word as { text?: unknown }).text);
        if (!text) {
          continue;
        }

        items.push({
          start,
          end,
          text,
          confidence: parseConfidence(word.confidence),
        });
      }
      continue;
    }

    const start = parseTime(segment.start);
    const end = parseTime(segment.end);
    if (start === null || end === null || end < start) {
      continue;
    }

    const text = parseText(segment.text);
    if (!text) {
      continue;
    }

    items.push({
      start,
      end,
      text,
      confidence: null,
    });
  }

  return items.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.text.localeCompare(b.text);
  });
}

/**
 * GET /api/transcript/:hash/compare - Get all transcript lanes for timeline comparison
 *
 * Query params:
 * - group: Optional group ID override
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  try {
    const { hash: rawHash } = await params;
    const hashResult = HashSchema.safeParse(rawHash);
    if (!hashResult.success) {
      return NextResponse.json(
        { error: "Invalid hash format" },
        { status: 400 }
      );
    }
    const hash = hashResult.data;

    const { searchParams } = new URL(request.url);
    const groupOverride = searchParams.get("group");

    const access = await resolveTranscriptRouteAccess({
      groupOverride,
      hash,
      accessDeniedMessage: "Access denied to this transcript",
      auditResource: "transcript",
    });
    if (!access.ok) {
      return access.response;
    }
    const { userId, group, transcriptsPath } = access;
    const priorities = await listTranscriptBackendPriorities();
    const available = await getAvailableTranscripts(transcriptsPath, hash, {
      priorities,
    });

    if (available.backends.length === 0) {
      const empty: TranscriptCompareResponse = { hash, tracks: [], duration: 0 };
      return NextResponse.json(empty);
    }

    const tracksRaw = await Promise.all(
      available.backends.map(async (backend) => {
        const transcript = await loadTranscript(transcriptsPath, hash, backend);
        if (!transcript) {
          return null;
        }

        return {
          backend,
          items: toCompareItems(transcript),
        } satisfies TranscriptCompareTrack;
      })
    );

    const tracks = tracksRaw.filter(
      (track): track is TranscriptCompareTrack => track !== null
    );

    const duration = tracks.reduce((maxDuration, track) => {
      const laneMaxEnd = track.items.reduce(
        (trackMaxEnd, item) => Math.max(trackMaxEnd, item.end),
        0
      );
      return Math.max(maxDuration, laneMaxEnd);
    }, 0);

    await logTranscriptViewed(userId, hash, group.id, "compare-stream");

    const response: TranscriptCompareResponse = {
      hash,
      tracks,
      duration,
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Error loading transcript compare stream:", error);
    return NextResponse.json(
      { error: "Failed to load transcript compare stream" },
      { status: 500 }
    );
  }
}
