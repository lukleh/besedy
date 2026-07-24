import { AccessLevel } from "@/generated/prisma/client";
import { AuthError, requireAuth } from "@/lib/auth/permissions";
import {
  getLabsPreferenceForUser,
  isFeatureEnabledForUser,
} from "@/lib/features/capabilities";
import { resolveCatalogActorContext } from "@/lib/policy/actor";
import {
  canAttachRecordingToEvent,
  canBrowseEvents,
  canCreateEventFromRecording,
  canDetachRecordingFromEvent,
  canEditEvent,
  canReleaseEvent,
  canSetPrimaryRecording,
  EVENTS_VIEW_ACCESS_LEVEL,
  type EventFeaturePolicyContext,
} from "@/lib/policy/event";

export type CatalogEventsAccessMode =
  | "view"
  | "edit"
  | "release_event"
  | "attach_recording"
  | "detach_recording"
  | "set_primary_recording"
  | "create_from_recording";

interface CatalogEventsAccessResult {
  userId: string;
  accessLevel: AccessLevel | null;
  policyContext: EventFeaturePolicyContext;
}

interface CatalogEventsAccessOptions {
  activeCatalogOnly?: boolean;
}

function isAllowedForCatalogEventsMode(
  mode: CatalogEventsAccessMode,
  context: EventFeaturePolicyContext
): boolean {
  switch (mode) {
    case "view":
      return canBrowseEvents(context);
    case "edit":
      return canEditEvent(context);
    case "release_event":
      return canReleaseEvent(context);
    case "attach_recording":
      return canAttachRecordingToEvent(context);
    case "detach_recording":
      return canDetachRecordingFromEvent(context);
    case "set_primary_recording":
      return canSetPrimaryRecording(context);
    case "create_from_recording":
      return canCreateEventFromRecording(context);
  }
}

function deniedMessageForCatalogEventsMode(mode: CatalogEventsAccessMode): string {
  switch (mode) {
    case "view":
      return `Catalog access required: ${EVENTS_VIEW_ACCESS_LEVEL} or higher`;
    case "edit":
      return "Owner or admin access required for event edit operations";
    case "release_event":
      return "Owner or admin access required to change event release state";
    case "attach_recording":
      return "Owner or admin access required to attach recordings to events";
    case "detach_recording":
      return "Owner or admin access required to detach recordings from events";
    case "set_primary_recording":
      return "Owner or admin access required to set the primary recording";
    case "create_from_recording":
      return "Owner or admin access required to create events from recordings";
  }
}

export async function requireCatalogEventsAccess(
  catalogId: string,
  mode: CatalogEventsAccessMode,
  options: CatalogEventsAccessOptions = {}
): Promise<CatalogEventsAccessResult> {
  const userId = await requireAuth();

  const [actor, labsPreference] = await Promise.all([
    resolveCatalogActorContext(catalogId, userId, options),
    getLabsPreferenceForUser(userId),
  ]);

  if (!actor.catalogExists) {
    throw new AuthError("Catalog not found", 404);
  }

  if (!actor.canEnterPortal) {
    throw new AuthError("Portal access required", 403);
  }

  const featureEnabled = isFeatureEnabledForUser("events", labsPreference.enabled);
  if (!featureEnabled) {
    throw new AuthError("Events feature is not enabled", 403);
  }

  const policyContext: EventFeaturePolicyContext = {
    featureEnabled,
    catalogExists: actor.catalogExists,
    canEnterPortal: actor.canEnterPortal,
    catalogGrant: actor.catalogGrant,
    isCatalogAdmin: actor.isCatalogAdmin,
  };

  if (!isAllowedForCatalogEventsMode(mode, policyContext)) {
    throw new AuthError(deniedMessageForCatalogEventsMode(mode), 403);
  }

  return { userId, accessLevel: actor.catalogGrant, policyContext };
}
