import type { AuditLog, AuditLogGroup, AuditGroupKey } from "./types";

/**
 * Generate a stable key string from group key components
 */
export function serializeGroupKey(key: AuditGroupKey): string {
  return `${key.userId ?? "null"}|${key.action}|${key.resource}|${key.resourceId ?? "null"}`;
}

/**
 * Group audit log entries by (userId, action, resource, resourceId)
 *
 * Groups are sorted by most recent entry timestamp (desc).
 * Entries within each group are sorted by timestamp (desc).
 */
export function groupLogsByKey(logs: AuditLog[]): AuditLogGroup[] {
  if (logs.length === 0) return [];

  // Group entries by key
  const groupMap = new Map<string, AuditLogGroup>();

  for (const log of logs) {
    const groupKey: AuditGroupKey = {
      userId: log.userId,
      action: log.action,
      resource: log.resource,
      resourceId: log.resourceId,
    };
    const keyString = serializeGroupKey(groupKey);

    const existing = groupMap.get(keyString);
    if (existing) {
      existing.entries.push(log);
      // Update timestamps if this entry is more recent or older
      if (log.createdAt > existing.mostRecentTimestamp) {
        existing.mostRecentTimestamp = log.createdAt;
        existing.user = log.user;
      }
      if (log.createdAt < existing.oldestTimestamp) {
        existing.oldestTimestamp = log.createdAt;
      }
    } else {
      groupMap.set(keyString, {
        key: keyString,
        groupKey,
        entries: [log],
        mostRecentTimestamp: log.createdAt,
        oldestTimestamp: log.createdAt,
        user: log.user,
      });
    }
  }

  // Convert to array and sort groups by most recent timestamp (desc)
  const groups = Array.from(groupMap.values());
  groups.sort(
    (a, b) =>
      new Date(b.mostRecentTimestamp).getTime() -
      new Date(a.mostRecentTimestamp).getTime()
  );

  // Sort entries within each group by timestamp (desc)
  for (const group of groups) {
    group.entries.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  return groups;
}

/**
 * Action categories for badge styling
 */
export const ACTION_CATEGORIES = {
  auth: ["LOGIN", "LOGOUT", "LOGIN_FAILED"],
  admission: [
    "PORTAL_ADMISSION_CREATED",
    "PORTAL_ADMISSION_UPDATED",
    "PORTAL_ADMISSION_CLAIMED",
    "PORTAL_ADMISSION_REVOKED",
    "PORTAL_ADMISSION_RESET",
    "PENDING_CATALOG_GRANT_CREATED",
    "PENDING_CATALOG_GRANT_UPDATED",
    "PENDING_CATALOG_GRANT_REVOKED",
    "PENDING_CATALOG_GRANT_CONSUMED",
  ],
  user: ["USER_ADDED", "USER_ACTIVATED", "USER_BLOCKED", "USER_UNBLOCKED"],
  admin: ["ADMIN_ROLE_GRANTED", "ADMIN_ROLE_REVOKED"],
  permission: [
    "CATALOG_ACCESS_GRANTED",
    "CATALOG_ACCESS_UPDATED",
    "CATALOG_ACCESS_REVOKED",
  ],
  data: [
    "CATALOG_VIEWED",
    "AUDIO_STREAMED",
    "AUDIO_DOWNLOADED",
    "TRANSCRIPT_VIEWED",
    "TRANSCRIPT_DOWNLOADED",
  ],
  content: ["METADATA_UPDATED", "METADATA_VERIFIED"],
  security: ["ACCESS_DENIED", "SUPERADMIN_ACCESS"],
};

export const ALL_ACTIONS = Object.values(ACTION_CATEGORIES).flat();

export function getActionBadgeVariant(
  action: string
): "default" | "secondary" | "destructive" | "outline" {
  if (ACTION_CATEGORIES.security.includes(action)) return "destructive";
  if (ACTION_CATEGORIES.auth.includes(action)) return "default";
  if (ACTION_CATEGORIES.data.includes(action)) return "secondary";
  return "outline";
}

export function getOutcomeBadgeVariant(
  outcome: string
): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "failure" || outcome === "denied") return "destructive";
  if (outcome === "info") return "secondary";
  if (outcome === "changed") return "outline";
  return "default";
}

export function formatDomainLabel(domain: string): string {
  return domain
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1))
    .join(" ");
}

export function formatUserAgent(ua: string | null): string {
  if (!ua) return "-";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari")) return "Safari";
  if (ua.includes("Edge")) return "Edge";
  return ua.slice(0, 30) + "...";
}

export function formatActionLabel(action: string): string {
  return action
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Format a timestamp range for display
 */
export function formatTimestampRange(
  mostRecent: string,
  oldest: string
): string {
  const recent = new Date(mostRecent);
  const old = new Date(oldest);

  const formatTime = (d: Date) =>
    d.toISOString().replace("T", " ").slice(11, 19);
  const formatDate = (d: Date) => d.toISOString().slice(0, 10);

  // Same day
  if (formatDate(recent) === formatDate(old)) {
    if (formatTime(recent) === formatTime(old)) {
      return formatTime(recent);
    }
    return `${formatTime(old)} - ${formatTime(recent)}`;
  }

  // Different days
  return `${formatDate(old)} - ${formatDate(recent)}`;
}
