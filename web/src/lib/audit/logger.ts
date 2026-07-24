import { headers } from "next/headers";
import prisma from "@/lib/db";
import { toPrismaJson } from "@/lib/prisma-json";
import { AuditAction } from "@/generated/prisma/enums";
import type { AuditAction as AuditActionType } from "@/generated/prisma/enums";
import { createServerLogger } from "@/lib/log/server";
import {
  AUDIT_PAYLOAD_VERSION,
  buildAuditDetails,
  buildAuditSummary,
  inferAuditDomain,
  inferAuditOutcome,
  inferSubjectType,
  type AuditActorSnapshot,
  type AuditDomain,
  type AuditOutcome,
  type AuditSubjectSnapshot,
  type AuditSubjectType,
} from "./model";

export { AuditAction };
export type { AuditActionType };
const logger = createServerLogger();

type AuditPayload = Record<string, unknown> | null;

type AuthAuditAction = "LOGIN" | "LOGOUT" | "LOGIN_FAILED";
type SecurityAuditAction = "ACCESS_DENIED" | "SUPERADMIN_ACCESS";
type UserLifecycleAction =
  | "USER_ADDED"
  | "USER_ACTIVATED"
  | "USER_BLOCKED"
  | "USER_UNBLOCKED"
  | "USER_DELETED";
type AdminRoleAction = "ADMIN_ROLE_GRANTED" | "ADMIN_ROLE_REVOKED";
type PortalAdmissionAction =
  | "PORTAL_ADMISSION_CREATED"
  | "PORTAL_ADMISSION_UPDATED"
  | "PORTAL_ADMISSION_CLAIMED"
  | "PORTAL_ADMISSION_REVOKED"
  | "PORTAL_ADMISSION_RESET";
type PendingCatalogGrantAction =
  | "PENDING_CATALOG_GRANT_CREATED"
  | "PENDING_CATALOG_GRANT_UPDATED"
  | "PENDING_CATALOG_GRANT_REVOKED"
  | "PENDING_CATALOG_GRANT_CONSUMED";
type CatalogAccessAction =
  | "CATALOG_ACCESS_GRANTED"
  | "CATALOG_ACCESS_UPDATED"
  | "CATALOG_ACCESS_REVOKED";
type CatalogLifecycleAction =
  | "CATALOG_CREATED"
  | "CATALOG_UPDATED"
  | "CATALOG_DEACTIVATED";
type DataAccessAction =
  | "CATALOG_VIEWED"
  | "AUDIO_STREAMED"
  | "AUDIO_DOWNLOADED"
  | "TRANSCRIPT_VIEWED"
  | "TRANSCRIPT_DOWNLOADED";
type ContentAuditAction =
  | "METADATA_UPDATED"
  | "METADATA_VERIFIED"
  | "METADATA_DELETED";

export interface AuditLogParams {
  userId?: string | null;
  action: AuditActionType;
  domain?: AuditDomain | null;
  subjectType?: AuditSubjectType | null;
  subjectId?: string | null;
  catalogId?: string | null;
  outcome?: AuditOutcome | null;
  payloadVersion?: number | null;
  resource: string;
  resourceId?: string | null;
  details?: Record<string, unknown> | null;
  request?: Request | null;
}

export interface AuditEventParams {
  userId?: string | null;
  action: AuditActionType;
  resource: string;
  resourceId?: string | null;
  payload?: Record<string, unknown> | null;
  domain?: AuditDomain;
  subjectType?: AuditSubjectType;
  subjectId?: string | null;
  catalogId?: string | null;
  outcome?: AuditOutcome;
  summary?: string;
  actorSnapshot?: AuditActorSnapshot | null;
  subjectSnapshot?: AuditSubjectSnapshot | null;
  request?: Request | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function defaultActorSnapshot(userId?: string | null): AuditActorSnapshot {
  if (userId) {
    return {
      type: "user",
      userId,
    };
  }

  return {
    type: "anonymous",
  };
}

function mergePayload(base: AuditPayload, extra: AuditPayload): AuditPayload {
  if (!base && !extra) {
    return null;
  }

  return {
    ...(base ?? {}),
    ...(extra ?? {}),
  };
}

/**
 * Extract client IP address from request headers
 */
async function getClientIp(): Promise<string | null> {
  try {
    const headersList = await headers();
    const forwardedFor = headersList.get("x-forwarded-for");
    if (forwardedFor) {
      return forwardedFor.split(",")[0].trim();
    }
    return headersList.get("x-real-ip");
  } catch {
    return null;
  }
}

/**
 * Extract user agent from request headers
 */
async function getUserAgent(): Promise<string | null> {
  try {
    const headersList = await headers();
    return headersList.get("user-agent");
  } catch {
    return null;
  }
}

/**
 * Log an audit event to the database.
 *
 * This low-level helper intentionally stays permissive so older raw call sites
 * can continue to work while the typed builders migrate the active writers.
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  try {
    const ipAddress = await getClientIp();
    const userAgent = await getUserAgent();

    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        action: params.action,
        domain: params.domain ?? null,
        subjectType: params.subjectType ?? null,
        subjectId: params.subjectId ?? null,
        catalogId: params.catalogId ?? null,
        outcome: params.outcome ?? null,
        payloadVersion: params.payloadVersion ?? null,
        resource: params.resource,
        resourceId: params.resourceId ?? null,
        details: toPrismaJson(params.details),
        ipAddress,
        userAgent,
      },
    });
  } catch (error) {
    logger.error("Failed to write audit log:", error);
  }
}

export async function logAuditEvent(params: AuditEventParams): Promise<void> {
  const subjectType = params.subjectType ?? inferSubjectType(params.action, params.resource);
  const subjectId = params.subjectId ?? params.resourceId ?? null;
  const actorSnapshot = params.actorSnapshot ?? defaultActorSnapshot(params.userId);
  const subjectSnapshot = params.subjectSnapshot
    ? {
        ...params.subjectSnapshot,
        type: params.subjectSnapshot.type ?? subjectType,
        id: params.subjectSnapshot.id ?? subjectId,
      }
    : {
        type: subjectType,
        id: subjectId,
      };
  const payload = params.payload ?? null;
  const summary =
    params.summary ??
    buildAuditSummary({
      action: params.action,
      resource: params.resource,
      resourceId: params.resourceId ?? null,
      payload,
      actorSnapshot,
      subjectSnapshot,
    });

  return logAudit({
    userId: params.userId ?? null,
    action: params.action,
    domain: params.domain ?? inferAuditDomain(params.action, params.resource),
    subjectType,
    subjectId,
    catalogId:
      params.catalogId ??
      subjectSnapshot.catalogId ??
      (isNonEmptyString(payload?.catalogId) ? payload.catalogId : null),
    outcome: params.outcome ?? inferAuditOutcome(params.action),
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    resource: params.resource,
    resourceId: params.resourceId ?? null,
    details: buildAuditDetails(payload, {
      payloadVersion: AUDIT_PAYLOAD_VERSION,
      domain: params.domain ?? inferAuditDomain(params.action, params.resource),
      subjectType,
      subjectId,
      catalogId:
        params.catalogId ??
        subjectSnapshot.catalogId ??
        (isNonEmptyString(payload?.catalogId) ? payload.catalogId : null),
      outcome: params.outcome ?? inferAuditOutcome(params.action),
      summary,
      actorSnapshot,
      subjectSnapshot,
    }),
    request: params.request ?? null,
  });
}

export async function logAuthEvent(params: {
  userId?: string | null;
  action: AuthAuditAction;
  email?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  const payload = mergePayload(params.details ?? null, params.email ? { email: params.email } : null);
  const subjectId = params.userId ?? params.email ?? null;

  return logAuditEvent({
    userId: params.userId ?? null,
    action: params.action as AuditActionType,
    resource: "auth",
    resourceId: params.userId ?? null,
    payload,
    domain: "auth",
    subjectType: "user",
    subjectId,
    subjectSnapshot: {
      type: "user",
      id: subjectId,
      label: params.email ?? params.userId ?? "User",
      secondaryLabel: params.email ?? null,
    },
  });
}

/**
 * Log a login event
 */
export async function logLogin(
  userId: string,
  details?: { provider?: string; email?: string }
): Promise<void> {
  await logAuthEvent({
    userId,
    action: "LOGIN",
    email: details?.email ?? null,
    details: details ?? null,
  });
}

/**
 * Log a failed login attempt
 */
export async function logLoginFailed(
  email?: string,
  details?: { reason?: string; provider?: string }
): Promise<void> {
  await logAuthEvent({
    userId: null,
    action: "LOGIN_FAILED",
    email: email ?? null,
    details: details ?? null,
  });
}

/**
 * Log a logout event
 */
export async function logLogout(userId: string): Promise<void> {
  await logAuthEvent({
    userId,
    action: "LOGOUT",
  });
}

export async function logSecurityEvent(params: {
  userId?: string | null;
  action: SecurityAuditAction;
  resource: string;
  resourceId?: string | null;
  subjectType?: AuditSubjectType;
  catalogId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.userId ?? null,
    action: params.action as AuditActionType,
    resource: params.resource,
    resourceId: params.resourceId ?? null,
    payload: params.details ?? null,
    domain: "security",
    subjectType: params.subjectType,
    subjectId: params.resourceId ?? null,
    catalogId: params.catalogId ?? null,
    outcome: params.action === "ACCESS_DENIED" ? "denied" : "info",
    subjectSnapshot: {
      type: params.subjectType ?? inferSubjectType(params.action, params.resource),
      id: params.resourceId ?? null,
      label:
        (params.details && isNonEmptyString(params.details.targetEmail) && params.details.targetEmail) ||
        params.resourceId ||
        params.resource,
      secondaryLabel:
        (params.details && isNonEmptyString(params.details.catalogId) && params.details.catalogId) || null,
      catalogId:
        params.catalogId ??
        (params.details && isNonEmptyString(params.details.catalogId) ? params.details.catalogId : null),
    },
  });
}

/**
 * Log an access denied event
 */
export async function logAccessDenied(
  userId: string | null,
  resource: string,
  resourceId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  await logSecurityEvent({
    userId,
    action: "ACCESS_DENIED",
    resource,
    resourceId: resourceId ?? null,
    catalogId: isNonEmptyString(details?.catalogId) ? details.catalogId : null,
    details: details ?? null,
  });
}

export async function logDataAccessEvent(params: {
  userId?: string | null;
  action: DataAccessAction;
  resource: string;
  resourceId?: string | null;
  groupId?: string | null;
  subjectType?: AuditSubjectType;
  subjectSnapshot?: AuditSubjectSnapshot | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  const payload = mergePayload(
    params.details ?? null,
    params.groupId ? { groupId: params.groupId } : null
  );

  return logAuditEvent({
    userId: params.userId ?? null,
    action: params.action as AuditActionType,
    resource: params.resource,
    resourceId: params.resourceId ?? null,
    payload,
    domain: "data_access",
    subjectType: params.subjectType,
    subjectId: params.resourceId ?? params.groupId ?? null,
    catalogId: params.groupId ?? null,
    subjectSnapshot:
      params.subjectSnapshot ??
      {
        type: params.subjectType ?? inferSubjectType(params.action, params.resource),
        id: params.resourceId ?? params.groupId ?? null,
        label: params.resourceId ?? params.groupId ?? params.resource,
        catalogId: params.groupId ?? null,
      },
  });
}

/**
 * Log catalog access
 */
export async function logCatalogViewed(
  userId: string | null,
  groupId: string,
  details?: { entryCount?: number }
): Promise<void> {
  await logDataAccessEvent({
    userId,
    action: "CATALOG_VIEWED",
    resource: "catalog",
    resourceId: groupId,
    groupId,
    subjectType: "catalog",
    details: details ?? null,
  });
}

/**
 * Range information for audio streaming
 */
export interface AudioStreamRange {
  start: number;
  end: number;
  fileSize: number;
}

/**
 * Log audio streaming
 */
export async function logAudioStreamed(
  userId: string | null,
  audioHash: string,
  groupId: string,
  range?: AudioStreamRange | null
): Promise<void> {
  await logDataAccessEvent({
    userId,
    action: "AUDIO_STREAMED",
    resource: "audio",
    resourceId: audioHash,
    groupId,
    subjectType: "audio",
    details: range
      ? {
          rangeStart: range.start,
          rangeEnd: range.end,
          fileSize: range.fileSize,
        }
      : null,
  });
}

/**
 * Log audio download
 */
export async function logAudioDownloaded(
  userId: string | null,
  audioHash: string,
  groupId: string,
  source?: string
): Promise<void> {
  await logDataAccessEvent({
    userId,
    action: "AUDIO_DOWNLOADED",
    resource: "audio",
    resourceId: audioHash,
    groupId,
    subjectType: "audio",
    details: source ? { source } : null,
  });
}

/**
 * Log transcript access
 */
export async function logTranscriptViewed(
  userId: string | null,
  audioHash: string,
  groupId: string,
  backend?: string
): Promise<void> {
  await logDataAccessEvent({
    userId,
    action: "TRANSCRIPT_VIEWED",
    resource: "transcript",
    resourceId: audioHash,
    groupId,
    subjectType: "transcript",
    details: backend ? { backend } : null,
  });
}

/**
 * Log transcript download
 */
export async function logTranscriptDownloaded(
  userId: string | null,
  audioHash: string,
  groupId: string,
  backend?: string,
  format?: string
): Promise<void> {
  await logDataAccessEvent({
    userId,
    action: "TRANSCRIPT_DOWNLOADED",
    resource: "transcript",
    resourceId: audioHash,
    groupId,
    subjectType: "transcript",
    details: {
      ...(backend ? { backend } : {}),
      ...(format ? { format } : {}),
    },
  });
}

export async function logUserLifecycleEvent(params: {
  action: UserLifecycleAction;
  actorId: string;
  targetUserId: string;
  targetEmail?: string | null;
  targetName?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "user",
    resourceId: params.targetUserId,
    payload: params.details ?? null,
    domain: "user",
    subjectType: "user",
    subjectId: params.targetUserId,
    subjectSnapshot: {
      type: "user",
      id: params.targetUserId,
      label: params.targetName ?? params.targetEmail ?? params.targetUserId,
      secondaryLabel:
        params.targetName && params.targetEmail ? params.targetEmail : null,
    },
  });
}

/**
 * Log user management events
 */
export async function logUserEvent(
  action: Exclude<UserLifecycleAction, "USER_DELETED">,
  actorId: string,
  targetUserId: string,
  details?: Record<string, unknown>
): Promise<void> {
  await logUserLifecycleEvent({
    action,
    actorId,
    targetUserId,
    targetEmail: isNonEmptyString(details?.email) ? details.email : null,
    details: details ?? null,
  });
}

export async function logAdminRoleEvent(params: {
  action: AdminRoleAction;
  actorId: string;
  targetUserId: string;
  targetEmail?: string | null;
  targetName?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "user",
    resourceId: params.targetUserId,
    payload: params.details ?? null,
    domain: "admin",
    subjectType: "user",
    subjectId: params.targetUserId,
    subjectSnapshot: {
      type: "user",
      id: params.targetUserId,
      label: params.targetName ?? params.targetEmail ?? params.targetUserId,
      secondaryLabel:
        params.targetName && params.targetEmail ? params.targetEmail : null,
    },
  });
}

export async function logPortalAdmissionEvent(params: {
  action: PortalAdmissionAction;
  actorId: string;
  resourceId: string;
  email: string;
  catalogId?: string | null;
  catalogLabel?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "portal_admission",
    resourceId: params.resourceId,
    payload: params.details ?? null,
    domain: "admission",
    subjectType: "portal_admission",
    subjectId: params.resourceId,
    catalogId: params.catalogId ?? null,
    subjectSnapshot: {
      type: "portal_admission",
      id: params.resourceId,
      label: params.email,
      secondaryLabel: params.catalogLabel ?? null,
      catalogId: params.catalogId ?? null,
      catalogLabel: params.catalogLabel ?? null,
    },
  });
}

export async function logPendingCatalogGrantEvent(params: {
  action: PendingCatalogGrantAction;
  actorId: string;
  resourceId: string;
  email: string;
  catalogId?: string | null;
  catalogLabel?: string | null;
  accessLevel?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "pending_catalog_grant",
    resourceId: params.resourceId,
    payload: mergePayload(
      params.details ?? null,
      params.accessLevel ? { accessLevel: params.accessLevel } : null
    ),
    domain: "admission",
    subjectType: "pending_catalog_grant",
    subjectId: params.resourceId,
    catalogId: params.catalogId ?? null,
    subjectSnapshot: {
      type: "pending_catalog_grant",
      id: params.resourceId,
      label: params.email,
      secondaryLabel: params.accessLevel ?? null,
      catalogId: params.catalogId ?? null,
      catalogLabel: params.catalogLabel ?? null,
    },
  });
}

/**
 * Log catalog access management
 */
export async function logCatalogAccessEvent(params: {
  action: CatalogAccessAction;
  actorId: string;
  accessResourceId: string;
  targetUserId?: string | null;
  targetEmail?: string | null;
  catalogId: string;
  catalogLabel?: string | null;
  accessLevel?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "catalog_access",
    resourceId: params.accessResourceId,
    payload: mergePayload(
      params.details ?? null,
      params.accessLevel ? { accessLevel: params.accessLevel } : null
    ),
    domain: "catalog_access",
    subjectType: "catalog_access",
    subjectId: params.accessResourceId,
    catalogId: params.catalogId,
    subjectSnapshot: {
      type: "catalog_access",
      id: params.accessResourceId,
      label: params.targetEmail ?? params.targetUserId ?? params.accessResourceId,
      secondaryLabel: params.accessLevel ?? null,
      catalogId: params.catalogId,
      catalogLabel: params.catalogLabel ?? null,
    },
  });
}

export async function logCatalogLifecycleEvent(params: {
  action: CatalogLifecycleAction;
  actorId: string;
  catalogId: string;
  catalogLabel?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: "catalog",
    resourceId: params.catalogId,
    payload: params.details ?? null,
    domain: "catalog",
    subjectType: "catalog",
    subjectId: params.catalogId,
    catalogId: params.catalogId,
    subjectSnapshot: {
      type: "catalog",
      id: params.catalogId,
      label: params.catalogLabel ?? params.catalogId,
      catalogId: params.catalogId,
      catalogLabel: params.catalogLabel ?? null,
    },
  });
}

export async function logCatalogPublicationEvent(params: {
  actorId: string;
  audioHash: string;
  catalogId: string;
  isPublished: boolean;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: AuditAction.CATALOG_UPDATED,
    resource: "catalog_publication",
    resourceId: params.audioHash,
    payload: {
      catalogId: params.catalogId,
      isPublished: params.isPublished,
    },
    domain: "catalog",
    subjectType: "catalog_publication",
    subjectId: params.audioHash,
    catalogId: params.catalogId,
    subjectSnapshot: {
      type: "catalog_publication",
      id: params.audioHash,
      label: params.audioHash,
      catalogId: params.catalogId,
    },
  });
}

export async function logContentEvent(params: {
  action: ContentAuditAction;
  actorId: string;
  resource: string;
  resourceId: string;
  catalogId?: string | null;
  catalogLabel?: string | null;
  payload?: Record<string, unknown> | null;
  subjectType?: AuditSubjectType;
}): Promise<void> {
  return logAuditEvent({
    userId: params.actorId,
    action: params.action as AuditActionType,
    resource: params.resource,
    resourceId: params.resourceId,
    payload: params.payload ?? null,
    domain: "content",
    subjectType: params.subjectType ?? inferSubjectType(params.action, params.resource),
    subjectId: params.resourceId,
    catalogId: params.catalogId ?? null,
    subjectSnapshot: {
      type: params.subjectType ?? inferSubjectType(params.action, params.resource),
      id: params.resourceId,
      label:
        (params.payload && isNonEmptyString(params.payload.title) && params.payload.title) ||
        params.resourceId,
      catalogId: params.catalogId ?? null,
      catalogLabel: params.catalogLabel ?? null,
    },
  });
}

/**
 * Log metadata update
 */
export async function logMetadataUpdated(
  userId: string,
  audioHash: string,
  groupId: string,
  changedFields?: string[]
): Promise<void> {
  await logContentEvent({
    action: "METADATA_UPDATED",
    actorId: userId,
    resource: "metadata",
    resourceId: audioHash,
    catalogId: groupId,
    subjectType: "metadata",
    payload: { groupId, changedFields },
  });
}

/**
 * Log metadata verification status change
 */
export async function logMetadataVerified(
  userId: string,
  audioHash: string,
  groupId: string,
  verified: boolean
): Promise<void> {
  await logContentEvent({
    action: "METADATA_VERIFIED",
    actorId: userId,
    resource: "metadata",
    resourceId: audioHash,
    catalogId: groupId,
    subjectType: "metadata",
    payload: { groupId, verified },
  });
}

/**
 * Log superadmin access (for tracking privileged operations)
 */
export async function logSuperadminAccess(
  userId: string,
  resource: string,
  resourceId?: string,
  action?: string
): Promise<void> {
  await logSecurityEvent({
    userId,
    action: "SUPERADMIN_ACCESS",
    resource,
    resourceId: resourceId ?? null,
    details: action ? { action } : null,
  });
}
