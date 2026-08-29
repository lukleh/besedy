import prisma from '@/lib/db';
import type { AccessLevel, UserStatus } from '@/generated/prisma/client';
import { listUserCatalogAccessEntries } from '@/lib/access/catalog-access-queries';
import { getUserFeaturePreferences } from '@/lib/features/capabilities';
import {
  hasSystemCatalogAuthority,
  resolvePortalActorContext,
  type PortalActorContext,
  type SystemRole,
} from '@/lib/policy/actor';
import {
  selectDefaultReadableGroup,
  type ReadableGroupResolutionSource,
} from '@/lib/catalog/resolve-readable-group';

export interface McpCatalogAccess {
  id: string;
  label: string | null;
  isUserDefault: boolean;
  isGlobalDefault: boolean;
  isEffectiveDefault: boolean;
  catalogGrant: AccessLevel | null;
  isCatalogAdmin: boolean;
  capabilities: {
    canListEvents: boolean;
    canGetRecordings: boolean;
    canViewTranscripts: boolean;
    canSearchTranscripts: boolean;
    canSeeUnreleasedEvents: boolean;
  };
}

const MCP_CATALOG_CAPABILITIES = {
  canListEvents: true,
  canGetRecordings: true,
  canViewTranscripts: true,
  canSearchTranscripts: true,
  canSeeUnreleasedEvents: false,
} as const;

export type McpDefaultCatalogSource =
  'user_preference' | 'global_default' | 'most_recent';

export interface McpAccessProfile {
  userId: string;
  userStatus: UserStatus | null;
  systemRole: SystemRole;
  canEnterPortal: boolean;
  defaultCatalogId: string | null;
  defaultCatalogSource: McpDefaultCatalogSource | null;
  catalogs: McpCatalogAccess[];
}

function serializeDefaultCatalogSource(
  source: Exclude<ReadableGroupResolutionSource, 'explicit'> | undefined,
): McpDefaultCatalogSource | null {
  switch (source) {
    case 'preference':
      return 'user_preference';
    case 'default':
      return 'global_default';
    case 'recent':
      return 'most_recent';
    default:
      return null;
  }
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
  const [actor, preferences] = await Promise.all([
    options.actor ?? resolvePortalActorContext(userId),
    getUserFeaturePreferences(userId),
  ]);

  if (!actor.canEnterPortal) {
    return emptyProfile(userId, actor.userStatus, actor.systemRole);
  }

  const accessEntries = await listUserCatalogAccessEntries(actor);
  const accessByCatalogId = new Map(
    accessEntries.map((entry) => [entry.catalogId, entry.accessLevel]),
  );

  const groups = await prisma.workflowGroup.findMany({
    where: {
      id: { in: accessEntries.map((entry) => entry.catalogId) },
      isActive: true,
    },
    select: {
      id: true,
      label: true,
      isDefault: true,
    },
    orderBy: { id: 'desc' },
  });

  const isCatalogAdmin = hasSystemCatalogAuthority(actor);
  const effectiveDefault = selectDefaultReadableGroup(
    groups,
    preferences.activeGroupId,
  );
  const catalogs = groups.map((group): McpCatalogAccess => {
    const accessLevel = accessByCatalogId.get(group.id) ?? null;
    const catalogGrant = isCatalogAdmin ? null : accessLevel;

    return {
      id: group.id,
      label: group.label,
      isUserDefault: preferences.activeGroupId === group.id,
      isGlobalDefault: group.isDefault,
      isEffectiveDefault: effectiveDefault?.group.id === group.id,
      catalogGrant,
      isCatalogAdmin,
      capabilities: MCP_CATALOG_CAPABILITIES,
    };
  });

  return {
    userId,
    userStatus: actor.userStatus,
    systemRole: actor.systemRole,
    canEnterPortal: true,
    defaultCatalogId: effectiveDefault?.group.id ?? null,
    defaultCatalogSource: serializeDefaultCatalogSource(
      effectiveDefault?.source,
    ),
    catalogs,
  };
}

function emptyProfile(
  userId: string,
  userStatus: UserStatus | null,
  systemRole: SystemRole,
): McpAccessProfile {
  return {
    userId,
    userStatus,
    systemRole,
    canEnterPortal: false,
    defaultCatalogId: null,
    defaultCatalogSource: null,
    catalogs: [],
  };
}
