import webpush from "web-push";
import { prisma } from "../db";
import { getVapidSubject } from "../runtime-config";
import {
  createPublicPushAgent,
  isPlausiblePushEndpoint,
  isUnsafePushEndpointError,
  UnsafePushEndpointError,
} from "./push-endpoint-policy";

let vapidConfigured: boolean | null = null;
let vapidWarned = false;
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const publicPushAgent = createPublicPushAgent();

function ensureVapidConfigured(): boolean {
  if (vapidConfigured !== null) {
    return vapidConfigured;
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = getVapidSubject();

  if (!publicKey || !privateKey) {
    const appEnv = process.env.APP_ENV;
    const isStrictProd =
      appEnv === "production" ||
      (!appEnv && process.env.NODE_ENV === "production");
    if (isStrictProd) {
      throw new Error(
        "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY environment variables are required for push notifications"
      );
    }
    vapidConfigured = false;
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

interface NotificationPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    url?: string;
    catalogId?: string;
    eventId?: number;
  };
}

async function sendPushNotification(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: NotificationPayload
): Promise<{ success: boolean; expired?: boolean }> {
  try {
    if (!isPlausiblePushEndpoint(subscription.endpoint)) {
      throw new UnsafePushEndpointError("Push endpoint failed structural validation");
    }
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      JSON.stringify(payload),
      {
        TTL: 24 * 60 * 60,
        urgency: "normal",
        timeout: PUSH_REQUEST_TIMEOUT_MS,
        agent: publicPushAgent,
      }
    );
    return { success: true };
  } catch (error: unknown) {
    if (isUnsafePushEndpointError(error)) {
      console.error("[Push] Removed unsafe push endpoint");
      return { success: false, expired: true };
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 410 || statusCode === 404) {
      return { success: false, expired: true };
    }
    // Permanent DNS failure (host not found) means the endpoint can never be
    // delivered to again — prune it. Transient failures (EAI_AGAIN, timeouts)
    // stay retryable.
    const errorCode = (error as { code?: string }).code;
    if (errorCode === "ENOTFOUND") {
      console.error("[Push] Removed push endpoint with unresolvable host");
      return { success: false, expired: true };
    }
    console.error("[Push] Failed to send:", error);
    return { success: false };
  }
}

export interface SendEventPushNotificationsInput {
  catalogId: string;
  eventId: number;
  eventTitle: string | null;
  recipientUserIds: string[];
}

export async function sendEventPushNotifications(
  input: SendEventPushNotificationsInput
): Promise<{ sent: number; failed: number }> {
  if (input.recipientUserIds.length === 0) {
    return { sent: 0, failed: 0 };
  }

  if (!ensureVapidConfigured()) {
    if (!vapidWarned) {
      console.warn(
        "[Push] VAPID keys not configured; skipping push notifications."
      );
      vapidWarned = true;
    }
    return { sent: 0, failed: 0 };
  }

  const [catalog, subscriptions] = await Promise.all([
    prisma.workflowGroup.findUnique({
      where: { id: input.catalogId },
      select: { label: true },
    }),
    prisma.pushSubscription.findMany({
      where: {
        userId: { in: input.recipientUserIds },
        user: {
          status: "ACTIVE",
        },
      },
      select: {
        endpoint: true,
        p256dh: true,
        auth: true,
      },
    }),
  ]);

  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const catalogName = catalog?.label || input.catalogId;
  const eventTitle = input.eventTitle?.trim() || "Untitled event";
  const payload: NotificationPayload = {
    title: "New Event Published",
    body: `${eventTitle} is now available in ${catalogName}`,
    icon: "/icon-192.svg",
    badge: "/badge-72.svg",
    tag: `new-event-${input.catalogId}-${input.eventId}`,
    data: {
      url: `/catalog/${input.catalogId}/event/${input.eventId}`,
      catalogId: input.catalogId,
      eventId: input.eventId,
    },
  };

  let sent = 0;
  let failed = 0;
  const expiredEndpoints: string[] = [];
  const successfulEndpoints: string[] = [];

  for (const subscription of subscriptions) {
    const result = await sendPushNotification(subscription, payload);
    if (result.success) {
      sent++;
      successfulEndpoints.push(subscription.endpoint);
    } else {
      failed++;
      if (result.expired) {
        expiredEndpoints.push(subscription.endpoint);
      }
    }
  }

  if (expiredEndpoints.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { endpoint: { in: expiredEndpoints } },
    });
    console.log(`[Push] Cleaned up ${expiredEndpoints.length} expired subscriptions`);
  }

  if (successfulEndpoints.length > 0) {
    await prisma.pushSubscription.updateMany({
      where: { endpoint: { in: successfulEndpoints } },
      data: { lastUsedAt: new Date() },
    });
  }

  return { sent, failed };
}
