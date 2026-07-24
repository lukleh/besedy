"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { fetchJson } from "@/lib/api/fetch-json";

interface EventNotification {
  id: string;
  catalogId: string;
  eventId: number;
  title: string | null;
  isRead: boolean;
  createdAt: string;
  catalog: {
    label: string | null;
  };
}

interface NotificationsResponse {
  notifications: EventNotification[];
  unreadCount: number;
}

const notificationSchema = z.object({
  id: z.string(),
  catalogId: z.string(),
  eventId: z.number(),
  title: z.string().nullable(),
  isRead: z.boolean(),
  createdAt: z.string(),
  catalog: z.object({
    label: z.string().nullable(),
  }),
});

const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  unreadCount: z.number(),
});

/**
 * Hook for fetching and managing event notifications.
 */
export function useNotifications() {
  const queryClient = useQueryClient();
  const foregroundIntervalMs = 2 * 60 * 1000;
  const backgroundIntervalMs = 2 * 60 * 60 * 1000;

  const query = useQuery<NotificationsResponse>({
    queryKey: ["notifications"],
    queryFn: () =>
      fetchJson<NotificationsResponse>("/api/notifications", {
        schema: notificationsResponseSchema,
      }),
    // Refetch frequently in foreground, slower when hidden/in background
    refetchInterval: () => {
      if (typeof document === "undefined") return false;
      return document.visibilityState === "hidden"
        ? backgroundIntervalMs
        : foregroundIntervalMs;
    },
    refetchIntervalInBackground: true,
  });

  const markAsRead = useMutation({
    mutationFn: (notificationIds: string[]) =>
      fetchJson("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const markAllAsRead = useMutation({
    mutationFn: () =>
      fetchJson("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markAllRead: true }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  return {
    notifications: query.data?.notifications ?? [],
    unreadCount: query.data?.unreadCount ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    markAsRead: markAsRead.mutate,
    markAllAsRead: markAllAsRead.mutate,
    refetch: query.refetch,
  };
}
