import prisma from "@/lib/db";
import type { AccessLevel } from "@/generated/prisma/client";
import { listUserCatalogAccessEntries } from "@/lib/access/catalog-access-queries";
import {
  getLabsPreferenceForUser,
  isFeatureEnabledForUser,
} from "@/lib/features/capabilities";
import { resolvePortalActorContext } from "@/lib/policy/actor";
import {
  canUseCatalogRag,
  canViewCatalog,
  canViewCatalogTranscripts,
} from "@/lib/policy/catalog";
import { canBrowseEvents, canViewUnreleasedEvents } from "@/lib/policy/event";

export interface McpCatalogAccess {
  id: string;
  label: string | null;
  isDefault: boolean;
  accessLevel: AccessLevel | "NONE";
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
  catalogs: McpCatalogAccess[];
  aggregate: {
    canListEvents: boolean;
    canGetRecordings: boolean;
    canViewTranscripts: boolean;
    canSearchTranscripts: boolean;
  };
}

export async function getMcpAccessProfile(
  userId: string
): Promise<McpAccessProfile> {
  const [actor, labsPreference] = await Promise.all([
    resolvePortalActorContext(userId),
    getLabsPreferenceForUser(userId),
  ]);

  if (!actor.canEnterPortal) {
    return emptyProfile(userId);
  }

  const accessEntries = await listUserCatalogAccessEntries(actor);
  const accessByCatalogId = new Map(
    accessEntries.map((entry) => [entry.catalogId, entry.accessLevel])
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
    orderBy: { id: "desc" },
  });

  const eventsEnabled = isFeatureEnabledForUser(
    "events",
    labsPreference.enabled
  );
  const isCatalogAdmin =
    actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN";
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
      isDefault: group.isDefault,
      accessLevel: accessLevel ?? "NONE",
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
    catalogs,
    aggregate: {
      canListEvents: catalogs.some(
        (catalog) => catalog.capabilities.canListEvents
      ),
      canGetRecordings: catalogs.some(
        (catalog) => catalog.capabilities.canGetRecordings
      ),
      canViewTranscripts: catalogs.some(
        (catalog) => catalog.capabilities.canViewTranscripts
      ),
      canSearchTranscripts: catalogs.some(
        (catalog) => catalog.capabilities.canSearchTranscripts
      ),
    },
  };
}

function emptyProfile(userId: string): McpAccessProfile {
  return {
    userId,
    canEnterPortal: false,
    catalogs: [],
    aggregate: {
      canListEvents: false,
      canGetRecordings: false,
      canViewTranscripts: false,
      canSearchTranscripts: false,
    },
  };
}
