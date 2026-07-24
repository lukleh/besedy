export const AUDIT_METADATA_KEY = "audit";
export const AUDIT_PAYLOAD_VERSION = 1;

export type AuditDomain =
  | "auth"
  | "admission"
  | "user"
  | "admin"
  | "catalog_access"
  | "catalog"
  | "data_access"
  | "content"
  | "security"
  | "unknown";

export type AuditOutcome = "success" | "changed" | "failure" | "denied" | "info";

export type AuditSubjectType =
  | "auth"
  | "user"
  | "portal_admission"
  | "pending_catalog_grant"
  | "catalog_access"
  | "catalog"
  | "catalog_publication"
  | "audio"
  | "transcript"
  | "metadata"
  | "unknown";

export interface AuditActorSnapshot {
  type: "user" | "system" | "anonymous";
  userId?: string | null;
  name?: string | null;
  email?: string | null;
}

export interface AuditSubjectSnapshot {
  type: AuditSubjectType;
  id?: string | null;
  label?: string | null;
  secondaryLabel?: string | null;
  catalogId?: string | null;
  catalogLabel?: string | null;
}

export interface AuditMetadataEnvelope {
  payloadVersion: typeof AUDIT_PAYLOAD_VERSION;
  domain: AuditDomain;
  subjectType: AuditSubjectType;
  subjectId?: string | null;
  catalogId?: string | null;
  outcome: AuditOutcome;
  summary: string;
  actorSnapshot?: AuditActorSnapshot | null;
  subjectSnapshot?: AuditSubjectSnapshot | null;
}

export interface AuditLogUser {
  id: string;
  name: string | null;
  email: string | null;
  image?: string | null;
}

export interface AuditActorView {
  kind: "user" | "system" | "anonymous";
  userId: string | null;
  label: string;
  secondaryLabel: string | null;
  image: string | null;
}

export interface AuditTargetView {
  type: AuditSubjectType;
  id: string | null;
  label: string;
  secondaryLabel: string | null;
  catalogId: string | null;
  catalogLabel: string | null;
}

export interface AuditListItem {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  rawDetails: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  user: AuditLogUser | null;
  domain: AuditDomain;
  outcome: AuditOutcome;
  summary: string;
  actor: AuditActorView;
  target: AuditTargetView | null;
  isCanonical: boolean;
}

export interface AuditDetailViewModel extends AuditListItem {
  relatedEntity?: unknown;
}

export interface AuditLogRecord {
  id: string;
  userId: string | null;
  action: string;
  domain?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  catalogId?: string | null;
  outcome?: string | null;
  payloadVersion?: number | null;
  resource: string;
  resourceId: string | null;
  details: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | Date;
  user: AuditLogUser | null;
}

interface AuditSummaryInput {
  action: string;
  resource: string;
  resourceId: string | null;
  payload: Record<string, unknown> | null;
  actorSnapshot?: AuditActorSnapshot | null;
  subjectSnapshot?: AuditSubjectSnapshot | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getCatalogLabel(
  payload: Record<string, unknown> | null,
  subjectSnapshot?: AuditSubjectSnapshot | null
): string | null {
  return (
    subjectSnapshot?.catalogLabel ??
    getString(payload?.catalogLabel) ??
    getString(payload?.groupLabel) ??
    getString(payload?.label)
  );
}

function getCatalogId(
  payload: Record<string, unknown> | null,
  subjectSnapshot?: AuditSubjectSnapshot | null
): string | null {
  return (
    subjectSnapshot?.catalogId ??
    getString(payload?.catalogId) ??
    getString(payload?.groupId)
  );
}

function getAccessLevel(
  payload: Record<string, unknown> | null,
  action: string
): string | null {
  return (
    getString(payload?.accessLevel) ??
    getString(payload?.newAccessLevel) ??
    (action === "CATALOG_ACCESS_REVOKED"
      ? getString(payload?.previousAccessLevel)
      : null)
  );
}

function humanizeAction(action: string): string {
  return action
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function pickSubjectLabel(
  payload: Record<string, unknown> | null,
  subjectSnapshot?: AuditSubjectSnapshot | null,
  resourceId?: string | null
): string | null {
  return (
    subjectSnapshot?.label ??
    subjectSnapshot?.secondaryLabel ??
    getString(payload?.targetEmail) ??
    getString(payload?.email) ??
    getString(payload?.label) ??
    getString(payload?.targetUserId) ??
    resourceId ??
    null
  );
}

function catalogSuffix(
  payload: Record<string, unknown> | null,
  subjectSnapshot?: AuditSubjectSnapshot | null
): string {
  const catalogLabel = getCatalogLabel(payload, subjectSnapshot);
  const catalogId = getCatalogId(payload, subjectSnapshot);
  if (catalogLabel) {
    return ` for ${catalogLabel}`;
  }
  if (catalogId) {
    return ` for ${catalogId}`;
  }
  return "";
}

export function inferAuditDomain(action: string, resource: string): AuditDomain {
  if (action === "LOGIN" || action === "LOGOUT" || action === "LOGIN_FAILED") {
    return "auth";
  }
  if (action.startsWith("PORTAL_ADMISSION_") || action.startsWith("PENDING_CATALOG_GRANT_")) {
    return "admission";
  }
  if (action.startsWith("USER_")) {
    return "user";
  }
  if (action.startsWith("ADMIN_ROLE_")) {
    return "admin";
  }
  if (action.startsWith("CATALOG_ACCESS_")) {
    return "catalog_access";
  }
  if (action === "CATALOG_CREATED" || action === "CATALOG_UPDATED" || action === "CATALOG_DEACTIVATED") {
    return "catalog";
  }
  if (
    action === "CATALOG_VIEWED" ||
    action === "AUDIO_STREAMED" ||
    action === "AUDIO_DOWNLOADED" ||
    action === "TRANSCRIPT_VIEWED" ||
    action === "TRANSCRIPT_DOWNLOADED"
  ) {
    return "data_access";
  }
  if (
    action === "METADATA_UPDATED" ||
    action === "METADATA_VERIFIED" ||
    action === "METADATA_DELETED"
  ) {
    return "content";
  }
  if (action === "ACCESS_DENIED" || action === "SUPERADMIN_ACCESS") {
    return "security";
  }
  if (resource === "catalog_access") {
    return "catalog_access";
  }
  if (resource === "catalog") {
    return "catalog";
  }
  if (resource === "audio" || resource === "transcript") {
    return "data_access";
  }
  if (resource === "metadata") {
    return "content";
  }
  return "unknown";
}

export function inferAuditOutcome(action: string): AuditOutcome {
  if (action === "LOGIN_FAILED") {
    return "failure";
  }
  if (action === "ACCESS_DENIED") {
    return "denied";
  }
  if (
    action === "PORTAL_ADMISSION_UPDATED" ||
    action === "PENDING_CATALOG_GRANT_UPDATED" ||
    action === "CATALOG_ACCESS_UPDATED" ||
    action === "CATALOG_UPDATED" ||
    action === "METADATA_UPDATED" ||
    action === "METADATA_VERIFIED" ||
    action === "USER_BLOCKED" ||
    action === "USER_UNBLOCKED" ||
    action === "USER_DELETED" ||
    action === "ADMIN_ROLE_GRANTED" ||
    action === "ADMIN_ROLE_REVOKED" ||
    action === "PORTAL_ADMISSION_REVOKED" ||
    action === "PENDING_CATALOG_GRANT_REVOKED" ||
    action === "CATALOG_ACCESS_REVOKED" ||
    action === "CATALOG_DEACTIVATED" ||
    action === "METADATA_DELETED"
  ) {
    return "changed";
  }
  if (action === "SUPERADMIN_ACCESS") {
    return "info";
  }
  return "success";
}

export function inferSubjectType(action: string, resource: string): AuditSubjectType {
  if (resource === "portal_admission" || action.startsWith("PORTAL_ADMISSION_")) {
    return "portal_admission";
  }
  if (resource === "pending_catalog_grant" || action.startsWith("PENDING_CATALOG_GRANT_")) {
    return "pending_catalog_grant";
  }
  if (resource === "catalog_access" || action.startsWith("CATALOG_ACCESS_")) {
    return "catalog_access";
  }
  if (resource === "catalog" || action.startsWith("CATALOG_")) {
    return "catalog";
  }
  if (resource === "catalog_publication") {
    return "catalog_publication";
  }
  if (resource === "audio") {
    return "audio";
  }
  if (resource === "transcript") {
    return "transcript";
  }
  if (resource === "metadata" || resource === "metadata-read") {
    return "metadata";
  }
  if (resource === "auth") {
    return "auth";
  }
  if (resource === "user") {
    return "user";
  }
  return "unknown";
}

export function buildAuditSummary({
  action,
  resource,
  resourceId,
  payload,
  actorSnapshot,
  subjectSnapshot,
}: AuditSummaryInput): string {
  const subjectLabel = pickSubjectLabel(payload, subjectSnapshot, resourceId) ?? "target";
  const accessLevel = getAccessLevel(payload, action);
  const accessPrefix = accessLevel ? `${accessLevel} access` : "Catalog access";
  const catalogInfo = catalogSuffix(payload, subjectSnapshot);
  const actorLabel =
    actorSnapshot?.name ??
    actorSnapshot?.email ??
    (actorSnapshot?.type === "system" ? "System" : null);

  switch (action) {
    case "LOGIN":
      return actorLabel ? `${actorLabel} signed in` : "User signed in";
    case "LOGIN_FAILED":
      return `Sign-in failed for ${subjectLabel}`;
    case "LOGOUT":
      return actorLabel ? `${actorLabel} signed out` : "User signed out";
    case "PORTAL_ADMISSION_CREATED":
      return `Portal admission created for ${subjectLabel}`;
    case "PORTAL_ADMISSION_UPDATED":
      return `Portal admission updated for ${subjectLabel}`;
    case "PORTAL_ADMISSION_CLAIMED":
      return `Portal admission claimed by ${subjectLabel}`;
    case "PORTAL_ADMISSION_REVOKED":
      return `Portal admission revoked for ${subjectLabel}`;
    case "PORTAL_ADMISSION_RESET":
      return `Portal admission reset for ${subjectLabel}`;
    case "PENDING_CATALOG_GRANT_CREATED":
      return `Pending ${accessLevel ?? "catalog"} grant created for ${subjectLabel}${catalogInfo}`;
    case "PENDING_CATALOG_GRANT_UPDATED":
      return `Pending catalog grant updated for ${subjectLabel}${catalogInfo}`;
    case "PENDING_CATALOG_GRANT_REVOKED":
      return `Pending catalog grant revoked for ${subjectLabel}${catalogInfo}`;
    case "PENDING_CATALOG_GRANT_CONSUMED":
      return `Pending catalog grant consumed for ${subjectLabel}${catalogInfo}`;
    case "USER_ADDED":
      return `User record created for ${subjectLabel}`;
    case "USER_ACTIVATED":
      return `User activated: ${subjectLabel}`;
    case "USER_BLOCKED":
      return `User blocked: ${subjectLabel}`;
    case "USER_UNBLOCKED":
      return `User unblocked: ${subjectLabel}`;
    case "USER_DELETED":
      return `User deleted: ${subjectLabel}`;
    case "ADMIN_ROLE_GRANTED":
      return `Admin role granted to ${subjectLabel}`;
    case "ADMIN_ROLE_REVOKED":
      return `Admin role revoked from ${subjectLabel}`;
    case "CATALOG_ACCESS_GRANTED":
      return `${accessPrefix} granted to ${subjectLabel}${catalogInfo}`;
    case "CATALOG_ACCESS_UPDATED":
      return `${accessPrefix} updated for ${subjectLabel}${catalogInfo}`;
    case "CATALOG_ACCESS_REVOKED":
      return `${accessPrefix} revoked for ${subjectLabel}${catalogInfo}`;
    case "CATALOG_CREATED":
      return `Catalog created: ${subjectLabel}`;
    case "CATALOG_UPDATED":
      if (resource === "catalog_publication") {
        return `Catalog publication updated for ${subjectLabel}${catalogInfo}`;
      }
      return `Catalog updated: ${subjectLabel}`;
    case "CATALOG_DEACTIVATED":
      return `Catalog deactivated: ${subjectLabel}`;
    case "CATALOG_VIEWED":
      return `Catalog viewed: ${subjectLabel}`;
    case "AUDIO_STREAMED":
      return `Audio streamed: ${subjectLabel}`;
    case "AUDIO_DOWNLOADED":
      return `Audio downloaded: ${subjectLabel}`;
    case "TRANSCRIPT_VIEWED":
      return `Transcript viewed: ${subjectLabel}`;
    case "TRANSCRIPT_DOWNLOADED":
      return `Transcript downloaded: ${subjectLabel}`;
    case "METADATA_UPDATED":
      return `Metadata updated for ${subjectLabel}`;
    case "METADATA_VERIFIED":
      return `Metadata verification updated for ${subjectLabel}`;
    case "METADATA_DELETED":
      return `Metadata deleted for ${subjectLabel}`;
    case "ACCESS_DENIED":
      return `Access denied to ${subjectLabel}`;
    case "SUPERADMIN_ACCESS":
      return `Superadmin access used on ${subjectLabel}`;
    default:
      return humanizeAction(action);
  }
}

export function buildAuditDetails(
  payload: Record<string, unknown> | null,
  audit: AuditMetadataEnvelope
): Record<string, unknown> {
  if (!payload || Object.keys(payload).length === 0) {
    return { [AUDIT_METADATA_KEY]: audit };
  }

  return {
    ...payload,
    [AUDIT_METADATA_KEY]: audit,
  };
}

export function getAuditMetadata(details: unknown): AuditMetadataEnvelope | null {
  if (!isRecord(details)) {
    return null;
  }

  const audit = details[AUDIT_METADATA_KEY];
  if (!isRecord(audit)) {
    return null;
  }

  if (audit.payloadVersion !== AUDIT_PAYLOAD_VERSION) {
    return null;
  }

  const domain = getString(audit.domain);
  const subjectType = getString(audit.subjectType);
  const outcome = getString(audit.outcome);
  const summary = getString(audit.summary);

  if (!domain || !subjectType || !outcome || !summary) {
    return null;
  }

  return {
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    domain: domain as AuditDomain,
    subjectType: subjectType as AuditSubjectType,
    subjectId: getString(audit.subjectId),
    catalogId: getString(audit.catalogId),
    outcome: outcome as AuditOutcome,
    summary,
    actorSnapshot: isRecord(audit.actorSnapshot)
      ? {
          type: (getString(audit.actorSnapshot.type) as AuditActorSnapshot["type"]) ?? "user",
          userId: getString(audit.actorSnapshot.userId),
          name: getString(audit.actorSnapshot.name),
          email: getString(audit.actorSnapshot.email),
        }
      : null,
    subjectSnapshot: isRecord(audit.subjectSnapshot)
      ? {
          type:
            (getString(audit.subjectSnapshot.type) as AuditSubjectType) ??
            "unknown",
          id: getString(audit.subjectSnapshot.id),
          label: getString(audit.subjectSnapshot.label),
          secondaryLabel: getString(audit.subjectSnapshot.secondaryLabel),
          catalogId: getString(audit.subjectSnapshot.catalogId),
          catalogLabel: getString(audit.subjectSnapshot.catalogLabel),
        }
      : null,
  };
}

export function getAuditPayload(details: unknown): Record<string, unknown> | null {
  if (!isRecord(details)) {
    return null;
  }

  const payload = { ...details };
  delete payload[AUDIT_METADATA_KEY];
  return Object.keys(payload).length > 0 ? payload : null;
}

function toCreatedAtString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function buildActorView(
  row: AuditLogRecord,
  metadata: AuditMetadataEnvelope | null
): AuditActorView {
  const actorSnapshot = metadata?.actorSnapshot;
  if (actorSnapshot?.type === "system") {
    return {
      kind: "system",
      userId: actorSnapshot.userId ?? null,
      label: actorSnapshot.name ?? "System",
      secondaryLabel: actorSnapshot.email ?? null,
      image: null,
    };
  }

  if (row.user) {
    return {
      kind: "user",
      userId: row.user.id,
      label: row.user.name ?? row.user.email ?? row.user.id,
      secondaryLabel:
        row.user.name && row.user.email ? row.user.email : null,
      image: row.user.image ?? null,
    };
  }

  if (actorSnapshot) {
    return {
      kind: actorSnapshot.type === "anonymous" ? "anonymous" : "user",
      userId: actorSnapshot.userId ?? row.userId ?? null,
      label:
        actorSnapshot.name ??
        actorSnapshot.email ??
        actorSnapshot.userId ??
        "Unknown user",
      secondaryLabel:
        actorSnapshot.name && actorSnapshot.email ? actorSnapshot.email : null,
      image: null,
    };
  }

  if (row.userId) {
    return {
      kind: "user",
      userId: row.userId,
      label: row.userId,
      secondaryLabel: null,
      image: null,
    };
  }

  return {
    kind: "system",
    userId: null,
    label: "System",
    secondaryLabel: null,
    image: null,
  };
}

function buildTargetView(
  row: AuditLogRecord,
  metadata: AuditMetadataEnvelope | null,
  payload: Record<string, unknown> | null
): AuditTargetView | null {
  const subjectSnapshot = metadata?.subjectSnapshot;
  const label = pickSubjectLabel(payload, subjectSnapshot, row.resourceId);
  if (!label && !subjectSnapshot && !row.resourceId) {
    return null;
  }

  return {
    type:
      (getString(row.subjectType) as AuditSubjectType | null) ??
      metadata?.subjectType ??
      inferSubjectType(row.action, row.resource),
    id:
      subjectSnapshot?.id ??
      metadata?.subjectId ??
      row.subjectId ??
      row.resourceId ??
      null,
    label: label ?? row.resource,
    secondaryLabel:
      subjectSnapshot?.secondaryLabel ??
      (label !== subjectSnapshot?.label ? getString(payload?.email) : null) ??
      null,
    catalogId:
      subjectSnapshot?.catalogId ??
      metadata?.catalogId ??
      row.catalogId ??
      getCatalogId(payload, subjectSnapshot),
    catalogLabel: getCatalogLabel(payload, subjectSnapshot),
  };
}

function buildSummary(row: AuditLogRecord, metadata: AuditMetadataEnvelope | null): string {
  const payload = getAuditPayload(row.details);
  if (metadata?.summary) {
    return metadata.summary;
  }

  return buildAuditSummary({
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    payload,
    actorSnapshot: metadata?.actorSnapshot,
    subjectSnapshot: metadata?.subjectSnapshot,
  });
}

export function mapAuditLogToListItem(row: AuditLogRecord): AuditListItem {
  const metadata = getAuditMetadata(row.details);
  const payload = getAuditPayload(row.details);
  const canonicalDomain = getString(row.domain) as AuditDomain | null;
  const canonicalOutcome = getString(row.outcome) as AuditOutcome | null;
  const isCanonical = Boolean(row.payloadVersion ?? row.domain ?? row.subjectType ?? row.outcome);

  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    details: payload,
    rawDetails: isRecord(row.details) ? row.details : null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: toCreatedAtString(row.createdAt),
    user: row.user,
    domain: canonicalDomain ?? metadata?.domain ?? inferAuditDomain(row.action, row.resource),
    outcome: canonicalOutcome ?? metadata?.outcome ?? inferAuditOutcome(row.action),
    summary: buildSummary(row, metadata),
    actor: buildActorView(row, metadata),
    target: buildTargetView(row, metadata, payload),
    isCanonical,
  };
}

export function mapAuditLogToDetailViewModel(
  row: AuditLogRecord,
  relatedEntity: unknown
): AuditDetailViewModel {
  return {
    ...mapAuditLogToListItem(row),
    relatedEntity,
  };
}
