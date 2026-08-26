import prisma from '@/lib/db';
import type { AccessLevel, UserStatus } from '@/generated/prisma/client';
import { buildCatalogCapability } from '@/lib/access/capabilities';
import { listUserCatalogAccessEntries } from '@/lib/access/catalog-access-queries';
import {
  getUserFeaturePreferences,
  isFeatureEnabledForUser,
} from '@/lib/features/capabilities';
import {
  hasSystemCatalogAuthority,
  resolvePortalActorContext,
  type SystemRole,
} from '@/lib/policy/actor';
import { canBrowseEvents, canViewUnreleasedEvents } from '@/lib/policy/event';
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
  aggregate: {
    canListEvents: boolean;
    canGetRecordings: boolean;
    canViewTranscripts: boolean;
    canSearchTranscripts: boolean;
  };
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
): Promise<McpAccessProfile> {
  const [actor, preferences] = await Promise.all([
    resolvePortalActorContext(userId),
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

  const eventsEnabled = isFeatureEnabledForUser(
    'events',
    preferences.labsPreference.enabled,
  );
  const isCatalogAdmin = hasSystemCatalogAuthority(actor);
  const effectiveDefault = selectDefaultReadableGroup(
    groups,
    preferences.activeGroupId,
  );
  const catalogs = groups.map((group): McpCatalogAccess => {
    const accessLevel = accessByCatalogId.get(group.id) ?? null;
    const catalogGrant = isCatalogAdmin ? null : accessLevel;
    const capability = buildCatalogCapability(
      {
        userId: actor.userId,
        isAuthenticated: actor.isAuthenticated,
        userStatus: actor.userStatus,
        canEnterPortal: actor.canEnterPortal,
      },
      group.id,
      true,
      catalogGrant,
      accessLevel,
      isCatalogAdmin,
    );
    const policyContext = {
      catalogExists: capability.catalogExists,
      canEnterPortal: capability.canEnterPortal,
      catalogGrant: capability.catalogGrant,
      isCatalogAdmin: capability.isCatalogAdmin,
    };

    return {
      id: group.id,
      label: group.label,
      isUserDefault: preferences.activeGroupId === group.id,
      isGlobalDefault: group.isDefault,
      isEffectiveDefault: effectiveDefault?.group.id === group.id,
      catalogGrant,
      isCatalogAdmin,
      capabilities: {
        canListEvents: canBrowseEvents({
          ...policyContext,
          featureEnabled: eventsEnabled,
        }),
        canGetRecordings: capability.canViewCatalog,
        canViewTranscripts: capability.canViewTranscripts,
        canSearchTranscripts: capability.canUseRagSearch,
        canSeeUnreleasedEvents: canViewUnreleasedEvents(policyContext),
      },
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
    aggregate: {
      canListEvents: catalogs.some(
        (catalog) => catalog.capabilities.canListEvents,
      ),
      canGetRecordings: catalogs.some(
        (catalog) => catalog.capabilities.canGetRecordings,
      ),
      canViewTranscripts: catalogs.some(
        (catalog) => catalog.capabilities.canViewTranscripts,
      ),
      canSearchTranscripts: catalogs.some(
        (catalog) => catalog.capabilities.canSearchTranscripts,
      ),
    },
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
    aggregate: {
      canListEvents: false,
      canGetRecordings: false,
      canViewTranscripts: false,
      canSearchTranscripts: false,
    },
  };
}
