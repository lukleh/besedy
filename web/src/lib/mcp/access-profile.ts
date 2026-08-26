import prisma from '@/lib/db';
import type { AccessLevel } from '@/generated/prisma/client';
import { listUserCatalogAccessEntries } from '@/lib/access/catalog-access-queries';
import {
  getUserFeaturePreferences,
  isFeatureEnabledForUser,
} from '@/lib/features/capabilities';
import { resolvePortalActorContext } from '@/lib/policy/actor';
import {
  canUseCatalogRag,
  canViewCatalog,
  canViewCatalogTranscripts,
} from '@/lib/policy/catalog';
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
  accessLevel: AccessLevel | 'NONE';
  capabilities: {
    canListEvents: boolean;
    canGetRecordings: boolean;
    canViewTranscripts: boolean;
    canSearchTranscripts: boolean;
    canSeeUnreleasedEvents: boolean;
  };
}

export interface McpAccessProfile {
  userId: string;
  canEnterPortal: boolean;
  defaultCatalogId: string | null;
  defaultCatalogSource: Exclude<
    ReadableGroupResolutionSource,
    'explicit'
  > | null;
  catalogs: McpCatalogAccess[];
  aggregate: {
    canListEvents: boolean;
    canGetRecordings: boolean;
    canViewTranscripts: boolean;
    canSearchTranscripts: boolean;
  };
}

export async function getMcpAccessProfile(
  userId: string,
): Promise<McpAccessProfile> {
  const [actor, preferences] = await Promise.all([
    resolvePortalActorContext(userId),
    getUserFeaturePreferences(userId),
  ]);

  if (!actor.canEnterPortal) {
    return emptyProfile(userId);
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
  const isCatalogAdmin =
    actor.systemRole === 'ADMIN' || actor.systemRole === 'SUPERADMIN';
  const effectiveDefault = selectDefaultReadableGroup(
    groups,
    preferences.activeGroupId,
  );
  const catalogs = groups.map((group): McpCatalogAccess => {
    const accessLevel = accessByCatalogId.get(group.id) ?? null;
    const policyContext = {
      catalogExists: true,
      canEnterPortal: actor.canEnterPortal,
      catalogGrant: isCatalogAdmin ? null : accessLevel,
      isCatalogAdmin,
    };

    return {
      id: group.id,
      label: group.label,
      isUserDefault: preferences.activeGroupId === group.id,
      isGlobalDefault: group.isDefault,
      isEffectiveDefault: effectiveDefault?.group.id === group.id,
      accessLevel: accessLevel ?? 'NONE',
      capabilities: {
        canListEvents: canBrowseEvents({
          ...policyContext,
          featureEnabled: eventsEnabled,
        }),
        canGetRecordings: canViewCatalog(policyContext),
        canViewTranscripts: canViewCatalogTranscripts(policyContext),
        canSearchTranscripts: canUseCatalogRag(policyContext),
        canSeeUnreleasedEvents: canViewUnreleasedEvents(policyContext),
      },
    };
  });

  return {
    userId,
    canEnterPortal: true,
    defaultCatalogId: effectiveDefault?.group.id ?? null,
    defaultCatalogSource: effectiveDefault?.source ?? null,
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

function emptyProfile(userId: string): McpAccessProfile {
  return {
    userId,
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
