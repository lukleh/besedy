import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { handlePrismaError } from "@/lib/api";
import { AuditAction } from "@/generated/prisma/enums";
import { requireAdminCapability } from "@/lib/access/require-admin";

export const dynamic = "force-dynamic";

interface TimeBucket {
  timestamp: string;
  label: string;
  audio: {
    plays: number;
    uniqueUsers: number;
  };
  users: {
    logins: number;
    signups: number;
  };
  security: {
    failedLogins: number;
    accessDenied: number;
    adminActions: number;
  };
}

interface TopUser {
  userId: string;
  name: string | null;
  email: string;
  count: number;
}

interface AnalyticsResponse {
  range: "24h" | "7d" | "30d" | "12m";
  buckets: TimeBucket[];
  summary: {
    audio: {
      totalPlays: number;
      uniqueUsers: number;
      uniqueTracks: number;
      topUsers: TopUser[];
    };
    users: {
      totalLogins: number;
      activeUsers: number;
      newSignups: number;
    };
    security: {
      failedLogins: number;
      accessDenied: number;
      adminActions: number;
    };
  };
  comparison: {
    audio: { totalPlays: number; uniqueUsers: number };
    users: { totalLogins: number; activeUsers: number; newSignups: number };
    security: { failedLogins: number; accessDenied: number };
  };
}

/**
 * GET /api/admin/audit/analytics - Get activity analytics for charts
 * Query params:
 *   - range: "24h" | "7d" (default: "24h")
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminCapability({ message: "Unauthorized" });

    const searchParams = request.nextUrl.searchParams;
    const rangeParam = searchParams.get("range");
    const range: "24h" | "7d" | "30d" | "12m" =
      rangeParam === "7d" ? "7d" :
      rangeParam === "30d" ? "30d" :
      rangeParam === "12m" ? "12m" : "24h";

    // Calculate time boundaries
    const now = new Date();
    const periodStart = new Date(now);
    const previousPeriodStart = new Date(now);

    if (range === "24h") {
      periodStart.setHours(periodStart.getHours() - 24);
      previousPeriodStart.setHours(previousPeriodStart.getHours() - 48);
    } else if (range === "7d") {
      periodStart.setDate(periodStart.getDate() - 7);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 14);
    } else if (range === "30d") {
      periodStart.setDate(periodStart.getDate() - 30);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 60);
    } else {
      // 12m - last 365 days (year)
      periodStart.setDate(periodStart.getDate() - 365);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 730);
    }

    // Fetch all data in parallel
    const [
      // Current period aggregates
      audioPlays,
      audioUniqueUsers,
      audioUniqueTracks,
      audioTopUsers,
      logins,
      activeUsers,
      newSignups,
      failedLogins,
      accessDenied,
      adminActions,

      // Previous period for comparison
      prevAudioPlays,
      prevAudioUniqueUsers,
      prevLogins,
      prevActiveUsers,
      prevNewSignups,
      prevFailedLogins,
      prevAccessDenied,

      // Time-bucketed data for charts
      bucketedData,
    ] = await Promise.all([
      // Audio plays - count actual listening sessions (when user switches to different audio)
      // Sequence 1,1,1,3,3,3,2,2,1,1 = 4 plays (not 15 events, not 3 unique tracks)
      prisma.$queryRaw<{ count: bigint }[]>`
        WITH ordered_events AS (
          SELECT
            user_id,
            resource_id,
            LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
          FROM audit_log
          WHERE action = 'AUDIO_STREAMED'
            AND domain IS NOT NULL
            AND created_at >= ${periodStart}
            AND user_id IS NOT NULL
            AND resource_id IS NOT NULL
        )
        SELECT COUNT(*) as count
        FROM ordered_events
        WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
      `.then((r) => Number(r[0]?.count ?? 0)),

      // Audio unique users
      prisma.auditLog.groupBy({
        by: ["userId"],
        where: {
          action: AuditAction.AUDIO_STREAMED,
          domain: { not: null },
          createdAt: { gte: periodStart },
          userId: { not: null },
        },
      }).then((r) => r.length),

      // Audio unique tracks
      prisma.auditLog.groupBy({
        by: ["resourceId"],
        where: {
          action: AuditAction.AUDIO_STREAMED,
          domain: { not: null },
          createdAt: { gte: periodStart },
          resourceId: { not: null },
        },
      }).then((r) => r.length),

      // Top audio users - count plays (listening sessions) per user
      // A play = when user switches to a different audio file
      prisma.$queryRaw<{ user_id: string; count: bigint }[]>`
        WITH ordered_events AS (
          SELECT
            user_id,
            resource_id,
            LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
          FROM audit_log
          WHERE action = 'AUDIO_STREAMED'
            AND domain IS NOT NULL
            AND created_at >= ${periodStart}
            AND user_id IS NOT NULL
            AND resource_id IS NOT NULL
        ),
        plays AS (
          SELECT user_id
          FROM ordered_events
          WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
        )
        SELECT user_id, COUNT(*) as count
        FROM plays
        GROUP BY user_id
        ORDER BY count DESC
        LIMIT 5
      `.then(async (rows) => {
        if (rows.length === 0) return [];
        const userIds = rows.map((r) => r.user_id);
        const users = await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        });
        const userMap = new Map(users.map((u) => [u.id, u]));
        return rows.map((r) => ({
          userId: r.user_id,
          name: userMap.get(r.user_id)?.name ?? null,
          email: userMap.get(r.user_id)?.email ?? "unknown",
          count: Number(r.count),
        }));
      }),

      // Logins
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN,
          domain: { not: null },
          createdAt: { gte: periodStart },
        },
      }),

      // Active users (distinct login users)
      prisma.auditLog.groupBy({
        by: ["userId"],
        where: {
          action: AuditAction.LOGIN,
          domain: { not: null },
          createdAt: { gte: periodStart },
          userId: { not: null },
        },
      }).then((r) => r.length),

      // New signups
      prisma.auditLog.count({
        where: {
          action: AuditAction.USER_ACTIVATED,
          domain: { not: null },
          createdAt: { gte: periodStart },
        },
      }),

      // Failed logins
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN_FAILED,
          domain: { not: null },
          createdAt: { gte: periodStart },
        },
      }),

      // Access denied
      prisma.auditLog.count({
        where: {
          action: AuditAction.ACCESS_DENIED,
          domain: { not: null },
          createdAt: { gte: periodStart },
        },
      }),

      // Admin actions
      prisma.auditLog.count({
        where: {
          action: {
            in: [
              AuditAction.ADMIN_ROLE_GRANTED,
              AuditAction.ADMIN_ROLE_REVOKED,
            ],
          },
          domain: { not: null },
          createdAt: { gte: periodStart },
        },
      }),

      // Previous period comparisons
      prisma.$queryRaw<{ count: bigint }[]>`
        WITH ordered_events AS (
          SELECT
            user_id,
            resource_id,
            LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
          FROM audit_log
          WHERE action = 'AUDIO_STREAMED'
            AND domain IS NOT NULL
            AND created_at >= ${previousPeriodStart}
            AND created_at < ${periodStart}
            AND user_id IS NOT NULL
            AND resource_id IS NOT NULL
        )
        SELECT COUNT(*) as count
        FROM ordered_events
        WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
      `.then((r) => Number(r[0]?.count ?? 0)),
      prisma.auditLog.groupBy({
        by: ["userId"],
        where: {
          action: AuditAction.AUDIO_STREAMED,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
          userId: { not: null },
        },
      }).then((r) => r.length),
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
        },
      }),
      prisma.auditLog.groupBy({
        by: ["userId"],
        where: {
          action: AuditAction.LOGIN,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
          userId: { not: null },
        },
      }).then((r) => r.length),
      prisma.auditLog.count({
        where: {
          action: AuditAction.USER_ACTIVATED,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
        },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.LOGIN_FAILED,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
        },
      }),
      prisma.auditLog.count({
        where: {
          action: AuditAction.ACCESS_DENIED,
          domain: { not: null },
          createdAt: { gte: previousPeriodStart, lt: periodStart },
        },
      }),

      // Time-bucketed data using raw SQL for date_trunc
      // 24h = hourly, 7d/30d = daily, 12m = monthly
      // For AUDIO_STREAMED: count plays (when resource changes), not raw events
      // For other actions: count events (COUNT(*))
      range === "24h"
        ? prisma.$queryRaw<
            { bucket: Date; action: string; count: bigint; unique_users: bigint }[]
          >`
            WITH audio_with_prev AS (
              SELECT
                date_trunc('hour', created_at) as bucket,
                user_id,
                resource_id,
                LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
              FROM audit_log
              WHERE action = 'AUDIO_STREAMED'
                AND domain IS NOT NULL
                AND created_at >= ${periodStart}
                AND user_id IS NOT NULL
                AND resource_id IS NOT NULL
            ),
            audio_plays AS (
              SELECT bucket, user_id
              FROM audio_with_prev
              WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
            ),
            audio_buckets AS (
              SELECT
                bucket,
                'AUDIO_STREAMED'::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audio_plays
              GROUP BY bucket
            ),
            other_buckets AS (
              SELECT
                date_trunc('hour', created_at) as bucket,
                action::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audit_log
              WHERE created_at >= ${periodStart}
                AND domain IS NOT NULL
                AND action IN ('LOGIN', 'LOGIN_FAILED', 'ACCESS_DENIED',
                               'USER_ACTIVATED', 'ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
              GROUP BY bucket, action
            )
            SELECT * FROM audio_buckets
            UNION ALL
            SELECT * FROM other_buckets
            ORDER BY bucket
          `
        : range === "12m"
        ? prisma.$queryRaw<
            { bucket: Date; action: string; count: bigint; unique_users: bigint }[]
          >`
            WITH audio_with_prev AS (
              SELECT
                date_trunc('month', created_at) as bucket,
                user_id,
                resource_id,
                LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
              FROM audit_log
              WHERE action = 'AUDIO_STREAMED'
                AND domain IS NOT NULL
                AND created_at >= ${periodStart}
                AND user_id IS NOT NULL
                AND resource_id IS NOT NULL
            ),
            audio_plays AS (
              SELECT bucket, user_id
              FROM audio_with_prev
              WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
            ),
            audio_buckets AS (
              SELECT
                bucket,
                'AUDIO_STREAMED'::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audio_plays
              GROUP BY bucket
            ),
            other_buckets AS (
              SELECT
                date_trunc('month', created_at) as bucket,
                action::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audit_log
              WHERE created_at >= ${periodStart}
                AND domain IS NOT NULL
                AND action IN ('LOGIN', 'LOGIN_FAILED', 'ACCESS_DENIED',
                               'USER_ACTIVATED', 'ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
              GROUP BY bucket, action
            )
            SELECT * FROM audio_buckets
            UNION ALL
            SELECT * FROM other_buckets
            ORDER BY bucket
          `
        : prisma.$queryRaw<
            { bucket: Date; action: string; count: bigint; unique_users: bigint }[]
          >`
            WITH audio_with_prev AS (
              SELECT
                date_trunc('day', created_at) as bucket,
                user_id,
                resource_id,
                LAG(resource_id) OVER (PARTITION BY user_id ORDER BY created_at) as prev_resource_id
              FROM audit_log
              WHERE action = 'AUDIO_STREAMED'
                AND domain IS NOT NULL
                AND created_at >= ${periodStart}
                AND user_id IS NOT NULL
                AND resource_id IS NOT NULL
            ),
            audio_plays AS (
              SELECT bucket, user_id
              FROM audio_with_prev
              WHERE resource_id != prev_resource_id OR prev_resource_id IS NULL
            ),
            audio_buckets AS (
              SELECT
                bucket,
                'AUDIO_STREAMED'::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audio_plays
              GROUP BY bucket
            ),
            other_buckets AS (
              SELECT
                date_trunc('day', created_at) as bucket,
                action::text as action,
                COUNT(*)::bigint as count,
                COUNT(DISTINCT user_id)::bigint as unique_users
              FROM audit_log
              WHERE created_at >= ${periodStart}
                AND domain IS NOT NULL
                AND action IN ('LOGIN', 'LOGIN_FAILED', 'ACCESS_DENIED',
                               'USER_ACTIVATED', 'ADMIN_ROLE_GRANTED', 'ADMIN_ROLE_REVOKED')
              GROUP BY bucket, action
            )
            SELECT * FROM audio_buckets
            UNION ALL
            SELECT * FROM other_buckets
            ORDER BY bucket
          `,
    ]);

    // Process bucketed data into time series
    const buckets = processBuckets(bucketedData, range, periodStart, now);

    const response: AnalyticsResponse = {
      range,
      buckets,
      summary: {
        audio: {
          totalPlays: audioPlays,
          uniqueUsers: audioUniqueUsers,
          uniqueTracks: audioUniqueTracks,
          topUsers: audioTopUsers,
        },
        users: {
          totalLogins: logins,
          activeUsers,
          newSignups,
        },
        security: {
          failedLogins,
          accessDenied,
          adminActions,
        },
      },
      comparison: {
        audio: {
          totalPlays: prevAudioPlays,
          uniqueUsers: prevAudioUniqueUsers,
        },
        users: {
          totalLogins: prevLogins,
          activeUsers: prevActiveUsers,
          newSignups: prevNewSignups,
        },
        security: {
          failedLogins: prevFailedLogins,
          accessDenied: prevAccessDenied,
        },
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return handlePrismaError(error, "audit analytics", "fetch");
  }
}

/**
 * Process raw bucketed data into a consistent time series
 */
function processBuckets(
  rawData: { bucket: Date; action: string; count: bigint; unique_users: bigint }[],
  range: "24h" | "7d" | "30d" | "12m",
  periodStart: Date,
  periodEnd: Date
): TimeBucket[] {
  // Create a map of bucket -> action -> counts
  const bucketMap = new Map<
    string,
    Map<string, { count: number; uniqueUsers: number }>
  >();

  for (const row of rawData) {
    const bucketKey = row.bucket.toISOString();
    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, new Map());
    }
    bucketMap.get(bucketKey)!.set(row.action, {
      count: Number(row.count),
      uniqueUsers: Number(row.unique_users),
    });
  }

  // Generate all expected buckets
  const buckets: TimeBucket[] = [];
  const current = new Date(periodStart);

  if (range === "24h") {
    // Round to start of hour in UTC (to match PostgreSQL date_trunc)
    current.setUTCMinutes(0, 0, 0);

    while (current <= periodEnd) {
      const bucketKey = current.toISOString();
      const actionMap = bucketMap.get(bucketKey) || new Map();

      // Include day number to make labels unique (e.g., "6/14:00" for day 6 at 14:00)
      const dayNum = current.getUTCDate();
      const hour = String(current.getUTCHours()).padStart(2, "0");
      buckets.push({
        timestamp: bucketKey,
        label: `${dayNum}/${hour}:00`,
        audio: {
          plays: actionMap.get("AUDIO_STREAMED")?.count ?? 0,
          uniqueUsers: actionMap.get("AUDIO_STREAMED")?.uniqueUsers ?? 0,
        },
        users: {
          logins: actionMap.get("LOGIN")?.count ?? 0,
          signups: actionMap.get("USER_ACTIVATED")?.count ?? 0,
        },
        security: {
          failedLogins: actionMap.get("LOGIN_FAILED")?.count ?? 0,
          accessDenied: actionMap.get("ACCESS_DENIED")?.count ?? 0,
          adminActions:
            (actionMap.get("ADMIN_ROLE_GRANTED")?.count ?? 0) +
            (actionMap.get("ADMIN_ROLE_REVOKED")?.count ?? 0),
        },
      });

      current.setUTCHours(current.getUTCHours() + 1);
    }
  } else if (range === "12m") {
    // 12m view - monthly buckets in UTC
    current.setUTCDate(1);
    current.setUTCHours(0, 0, 0, 0);

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    while (current <= periodEnd) {
      const bucketKey = current.toISOString();
      const actionMap = bucketMap.get(bucketKey) || new Map();

      buckets.push({
        timestamp: bucketKey,
        label: `${months[current.getUTCMonth()]} ${current.getUTCFullYear().toString().slice(-2)}`,
        audio: {
          plays: actionMap.get("AUDIO_STREAMED")?.count ?? 0,
          uniqueUsers: actionMap.get("AUDIO_STREAMED")?.uniqueUsers ?? 0,
        },
        users: {
          logins: actionMap.get("LOGIN")?.count ?? 0,
          signups: actionMap.get("USER_ACTIVATED")?.count ?? 0,
        },
        security: {
          failedLogins: actionMap.get("LOGIN_FAILED")?.count ?? 0,
          accessDenied: actionMap.get("ACCESS_DENIED")?.count ?? 0,
          adminActions:
            (actionMap.get("ADMIN_ROLE_GRANTED")?.count ?? 0) +
            (actionMap.get("ADMIN_ROLE_REVOKED")?.count ?? 0),
        },
      });

      current.setUTCMonth(current.getUTCMonth() + 1);
    }
  } else {
    // 7d/30d view - daily buckets in UTC (to match PostgreSQL date_trunc)
    current.setUTCHours(0, 0, 0, 0);

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    while (current <= periodEnd) {
      const bucketKey = current.toISOString();
      const actionMap = bucketMap.get(bucketKey) || new Map();

      // For 7d: "Wed 8", for 30d: "Jan 8"
      const label = range === "7d"
        ? `${weekdays[current.getUTCDay()]} ${current.getUTCDate()}`
        : `${months[current.getUTCMonth()]} ${current.getUTCDate()}`;

      buckets.push({
        timestamp: bucketKey,
        label,
        audio: {
          plays: actionMap.get("AUDIO_STREAMED")?.count ?? 0,
          uniqueUsers: actionMap.get("AUDIO_STREAMED")?.uniqueUsers ?? 0,
        },
        users: {
          logins: actionMap.get("LOGIN")?.count ?? 0,
          signups: actionMap.get("USER_ACTIVATED")?.count ?? 0,
        },
        security: {
          failedLogins: actionMap.get("LOGIN_FAILED")?.count ?? 0,
          accessDenied: actionMap.get("ACCESS_DENIED")?.count ?? 0,
          adminActions:
            (actionMap.get("ADMIN_ROLE_GRANTED")?.count ?? 0) +
            (actionMap.get("ADMIN_ROLE_REVOKED")?.count ?? 0),
        },
      });

      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  return buckets;
}
