import prisma from '@/lib/db';
import { requireArchive } from '@/lib/archive';
import {
  hasSystemCatalogAuthority,
  resolvePortalActorContext,
  type PortalActorContext,
} from '@/lib/policy/actor';

export interface McpArchiveAccess {
  id: string;
  label: string | null;
}

export interface McpAccessProfile {
  userId: string;
  canEnterPortal: boolean;
  archive: McpArchiveAccess | null;
}

export async function getMcpAccessProfile(
  userId: string,
  options: { actor?: PortalActorContext } = {},
): Promise<McpAccessProfile> {
  if (options.actor && options.actor.userId !== userId) {
    throw new Error(
      'MCP access profile actor does not match the requested user',
    );
  }
  const actor = options.actor ?? await resolvePortalActorContext(userId);
  if (!actor.canEnterPortal) {
    return { userId, canEnterPortal: false, archive: null };
  }

  const archive = await requireArchive();
  const access = hasSystemCatalogAuthority(actor)
    ? true
    : (await prisma.catalogAccess.findUnique({
        where: { userId_catalogId: { userId, catalogId: archive.id } },
        select: { status: true },
      }))?.status === 'ACTIVE';

  return {
    userId,
    canEnterPortal: true,
    archive: access ? archive : null,
  };
}
