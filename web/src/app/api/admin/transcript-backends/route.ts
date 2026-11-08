import { NextRequest, NextResponse } from "next/server";
import { requireArchive } from "@/lib/archive";
import { resolveTranscriptsPath } from "@/lib/paths";
import { discoverTranscriptBackends, orderTranscriptBackends } from "@/lib/transcript";
import {
  listTranscriptBackendPriorities,
  updateTranscriptBackendPriorities,
} from "@/lib/transcript-priority";
import { TranscriptBackendPriorityPayloadSchema } from "@/lib/validation/schemas";
import { validateRequestBody, handlePrismaError } from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

interface TranscriptBackendItem {
  backend: string;
  priority: number | null;
  discovered: boolean;
}

/**
 * GET /api/admin/transcript-backends
 * Returns discovered transcript backends with admin priorities.
 */
export async function GET() {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const archive = await requireArchive();

    const discovered = await discoverTranscriptBackends([resolveTranscriptsPath(archive.id)]);
    const priorities = await listTranscriptBackendPriorities();

    const orderedDiscovered = orderTranscriptBackends(discovered, priorities);
    const discoveredSet = new Set(discovered);

    const items: TranscriptBackendItem[] = orderedDiscovered.map((backend) => ({
      backend,
      priority: priorities[backend] ?? null,
      discovered: true,
    }));

    const extra = Object.keys(priorities)
      .filter((backend) => !discoveredSet.has(backend))
      .sort()
      .map((backend) => ({
        backend,
        priority: priorities[backend],
        discovered: false,
      }));

    return NextResponse.json({ items: [...items, ...extra] });
  } catch (error) {
    return handlePrismaError(error, "transcript backends", "fetch");
  }
}

/**
 * PUT /api/admin/transcript-backends
 * Body: { updates: [{ backend, priority }] }
 */
export async function PUT(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const bodyResult = await validateRequestBody(
      request,
      TranscriptBackendPriorityPayloadSchema
    );
    if (!bodyResult.success) return bodyResult.response;

    await updateTranscriptBackendPriorities(bodyResult.data.updates);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handlePrismaError(error, "transcript backends", "update");
  }
}
