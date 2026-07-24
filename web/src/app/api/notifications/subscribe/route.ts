/**
 * Push notification subscription management endpoints.
 * POST: Subscribe the current user's browser to push notifications
 * DELETE: Unsubscribe the current user's browser
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/permissions";
import prisma from "@/lib/db";
import { isPlausiblePushEndpoint } from "@/lib/notifications/push-endpoint-policy";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
    expirationTime: z.number().nullable().optional(),
  }),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

/**
 * POST /api/notifications/subscribe
 * Subscribe the current user's browser to push notifications.
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const body = await request.json();
    const parseResult = SubscribeSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid subscription data", details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { subscription } = parseResult.data;
    if (!isPlausiblePushEndpoint(subscription.endpoint)) {
      return NextResponse.json(
        {
          error:
            "Invalid push endpoint: must be a public https push service URL",
        },
        { status: 400 }
      );
    }
    const userAgent = request.headers.get("user-agent") || undefined;

    // A push endpoint identifies one browser subscription. Keep ownership unique
    // per endpoint so shared browsers do not retain multiple users on the same
    // underlying push channel.
    const pushSubscription = await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      },
      update: {
        userId,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent,
      },
    });

    return NextResponse.json(
      { id: pushSubscription.id, message: "Subscribed successfully" },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Subscribe] Error:", error);
    if (error instanceof Error && error.message === "Authentication required") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to subscribe" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/notifications/subscribe
 * Unsubscribe the current user's browser from push notifications.
 */
export async function DELETE(request: NextRequest) {
  try {
    const userId = await requireAuth();

    const body = await request.json();
    const parseResult = UnsubscribeSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parseResult.error.format() },
        { status: 400 }
      );
    }

    const { endpoint } = parseResult.data;

    // Only delete if the subscription belongs to the current user
    const deleted = await prisma.pushSubscription.deleteMany({
      where: {
        endpoint,
        userId,
      },
    });

    if (deleted.count === 0) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 }
      );
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[Unsubscribe] Error:", error);
    if (error instanceof Error && error.message === "Authentication required") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Failed to unsubscribe" },
      { status: 500 }
    );
  }
}
