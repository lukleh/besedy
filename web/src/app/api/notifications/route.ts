/**
 * User notifications endpoints.
 * GET: Get user's event notifications
 * PATCH: Mark notifications as read
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const MarkReadSchema = z.object({
  notificationIds: z.array(z.string()).optional(),
  markAllRead: z.boolean().optional(),
});

/**
 * GET /api/notifications
 * Get user's event notifications.
 * Query params: ?unread=true&catalogId=xxx
 */
export async function GET(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const { searchParams } = new URL(request.url);
    const unreadOnly = searchParams.get("unread") === "true";
    const catalogId = searchParams.get("catalogId");

    const notifications = await prisma.eventNotification.findMany({
      where: {
        userId,
        ...(unreadOnly && { isRead: false }),
        ...(catalogId && { catalogId }),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        catalogId: true,
        eventId: true,
        title: true,
        isRead: true,
        createdAt: true,
        catalog: {
          select: { label: true },
        },
      },
    });

    // Count total unread
    const unreadCount = await prisma.eventNotification.count({
      where: { userId, isRead: false },
    });

    return NextResponse.json({
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("[Notifications] Error:", error);
    if (error instanceof Error && error.message === "Authentication required") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to fetch notifications" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/notifications
 * Mark notifications as read.
 * Body: { notificationIds: [...] } or { markAllRead: true }
 */
export async function PATCH(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const body = await request.json();
    const parseResult = MarkReadSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400 }
      );
    }

    const { notificationIds, markAllRead } = parseResult.data;

    if (markAllRead) {
      await prisma.eventNotification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
      });
    } else if (notificationIds && notificationIds.length > 0) {
      await prisma.eventNotification.updateMany({
        where: {
          id: { in: notificationIds },
          userId, // Security: only update own notifications
        },
        data: { isRead: true, readAt: new Date() },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Notifications] Error:", error);
    if (error instanceof Error && error.message === "Authentication required") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to update notifications" },
      { status: 500 }
    );
  }
}
