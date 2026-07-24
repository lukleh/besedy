import type { PrismaClient } from "@/generated/prisma/client";

type EventNotificationClient = {
  catalogAccess: Pick<PrismaClient["catalogAccess"], "findMany">;
  eventNotification: Pick<
    PrismaClient["eventNotification"],
    "findMany" | "createMany"
  >;
};

export interface CreateEventNotificationsInput {
  catalogId: string;
  eventId: number;
  title: string | null;
}

export interface CreateEventNotificationsResult {
  created: number;
  recipientUserIds: string[];
}

export async function createEventNotifications(
  client: EventNotificationClient,
  input: CreateEventNotificationsInput
): Promise<CreateEventNotificationsResult> {
  const recipients = await client.catalogAccess.findMany({
    where: {
      catalogId: input.catalogId,
      status: "ACTIVE",
      user: {
        status: "ACTIVE",
      },
    },
    select: { userId: true },
  });

  const candidateUserIds = recipients.map((recipient) => recipient.userId);
  if (candidateUserIds.length === 0) {
    return { created: 0, recipientUserIds: [] };
  }

  const existing = await client.eventNotification.findMany({
    where: {
      catalogId: input.catalogId,
      eventId: input.eventId,
      userId: { in: candidateUserIds },
    },
    select: { userId: true },
  });

  const existingUserIds = new Set(existing.map((notification) => notification.userId));
  const recipientUserIds = candidateUserIds.filter((userId) => !existingUserIds.has(userId));
  if (recipientUserIds.length === 0) {
    return { created: 0, recipientUserIds: [] };
  }

  const result = await client.eventNotification.createMany({
    data: recipientUserIds.map((userId) => ({
      userId,
      catalogId: input.catalogId,
      eventId: input.eventId,
      title: input.title,
    })),
    skipDuplicates: true,
  });

  return {
    created: result.count,
    recipientUserIds,
  };
}
