import type { AuditListItem } from "@/lib/audit/model";

/**
 * Types for grouped audit log display
 */

export type AuditLog = AuditListItem;

/**
 * Key used to group audit log entries
 */
export interface AuditGroupKey {
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
}

/**
 * A group of audit log entries with the same key
 */
export interface AuditLogGroup {
  /** Serialized key for React key prop */
  key: string;
  /** The grouping key components */
  groupKey: AuditGroupKey;
  /** All entries in this group, sorted by timestamp desc */
  entries: AuditLog[];
  /** Timestamp of most recent entry */
  mostRecentTimestamp: string;
  /** Timestamp of oldest entry */
  oldestTimestamp: string;
  /** User info from most recent entry */
  user: AuditLog["user"];
}

/**
 * Pagination state for "Load more" pattern
 */
export interface LoadMorePagination {
  hasMore: boolean;
  totalCount: number;
  loadedCount: number;
}

export interface UserOption {
  id: string;
  name: string | null;
  email: string | null;
}
