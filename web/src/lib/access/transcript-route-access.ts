import { NextResponse } from "next/server";
import {
  getRecordingCapability,
  type RecordingCapability,
} from "@/lib/access/capabilities";
import { logAccessDenied } from "@/lib/audit/logger";
import { requireAuth } from "@/lib/auth/permissions";
import { resolveActiveGroup } from "@/lib/catalog/resolve-group";
import { resolveTranscriptsPath } from "@/lib/paths";

interface TranscriptRouteGroup {
  id: string;
}

export interface TranscriptRouteAccessSuccess {
  ok: true;
  userId: string;
  group: TranscriptRouteGroup;
  transcriptsPath: string;
  capability: RecordingCapability;
}

export interface TranscriptRouteAccessFailure {
  ok: false;
  response: NextResponse;
}

interface TranscriptRouteAccessOptions {
  groupOverride: string | null;
  hash: string;
  accessDeniedMessage: string;
  requireDownload?: boolean;
  auditResource?: string;
}

const TRANSCRIPT_ACCESS_DENIED =
  "Transcript access requires VIEWER role or higher";
const DOWNLOAD_ACCESS_DENIED = "Download not permitted for this transcript";

export async function resolveTranscriptRouteAccess(
  options: TranscriptRouteAccessOptions
): Promise<TranscriptRouteAccessSuccess | TranscriptRouteAccessFailure> {
  const userId = await requireAuth();
  const group = await resolveActiveGroup(options.groupOverride, userId);

  if (!group) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "No workflow group configured" },
        { status: 404 }
      ),
    };
  }

  const capability = await getRecordingCapability(group.id, options.hash, userId);

  if (!capability.canAccessRecording) {
    if (options.auditResource) {
      await logAccessDenied(userId, options.auditResource, options.hash, {
        groupId: group.id,
      });
    }

    return {
      ok: false,
      response: NextResponse.json(
        { error: options.accessDeniedMessage },
        { status: 403 }
      ),
    };
  }

  if (!capability.canViewRecordingTranscripts) {
    if (options.auditResource) {
      await logAccessDenied(userId, options.auditResource, options.hash, {
        groupId: group.id,
        reason: TRANSCRIPT_ACCESS_DENIED,
      });
    }

    return {
      ok: false,
      response: NextResponse.json(
        { error: TRANSCRIPT_ACCESS_DENIED },
        { status: 403 }
      ),
    };
  }

  if (options.requireDownload && !capability.canDownloadRecording) {
    if (options.auditResource) {
      await logAccessDenied(userId, options.auditResource, options.hash, {
        groupId: group.id,
        reason: "Download not permitted",
      });
    }

    return {
      ok: false,
      response: NextResponse.json(
        { error: DOWNLOAD_ACCESS_DENIED },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true,
    userId,
    group,
    transcriptsPath: resolveTranscriptsPath(group.id),
    capability,
  };
}
