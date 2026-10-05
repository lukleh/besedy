"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildRecordingBookmarksUrl } from "@/lib/api/recording-urls";
import {
  recordingBookmarkSchema,
  recordingBookmarksResponseSchema,
  type RecordingBookmark,
} from "@/lib/bookmarks/schemas";
import { z } from "zod";

const bookmarkResponseSchema = z.object({ bookmark: recordingBookmarkSchema });

export const USER_BOOKMARKS_QUERY_KEY = ["bookmarks"] as const;

export function recordingBookmarksQueryKey(catalogId: string, hash: string) {
  return ["bookmarks", catalogId, hash] as const;
}

export function bookmarkUrl(id: string): string {
  return `/api/bookmarks/${encodeURIComponent(id)}`;
}

export function sortBookmarks(bookmarks: RecordingBookmark[]): RecordingBookmark[] {
  return [...bookmarks].sort(
    (a, b) => a.positionSec - b.positionSec || a.createdAt.localeCompare(b.createdAt),
  );
}

/** The signed-in user's bookmarks in one recording, and the ways to change them. */
export function useRecordingBookmarks(catalogId: string, hash: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const queryKey = recordingBookmarksQueryKey(catalogId, hash);

  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (
        await fetchJson(buildRecordingBookmarksUrl(catalogId, hash), {
          schema: recordingBookmarksResponseSchema,
        })
      ).bookmarks,
    enabled,
  });

  // Each change also leaves the all-bookmarks list stale.
  const replaceBookmarks = (update: (current: RecordingBookmark[]) => RecordingBookmark[]) => {
    queryClient.setQueryData<RecordingBookmark[]>(queryKey, (current) =>
      sortBookmarks(update(current ?? [])),
    );
    void queryClient.invalidateQueries({ queryKey: USER_BOOKMARKS_QUERY_KEY, exact: true });
  };

  const create = useMutation({
    mutationFn: async (input: { positionSec: number; comment: string; excerpt: string | null }) =>
      (
        await fetchJson(buildRecordingBookmarksUrl(catalogId, hash), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          schema: bookmarkResponseSchema,
        })
      ).bookmark,
    onSuccess: (bookmark) => replaceBookmarks((current) => [...current, bookmark]),
  });

  const update = useMutation({
    mutationFn: async (input: { id: string; comment: string }) =>
      (
        await fetchJson(bookmarkUrl(input.id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comment: input.comment }),
          schema: bookmarkResponseSchema,
        })
      ).bookmark,
    onSuccess: (bookmark) =>
      replaceBookmarks((current) =>
        current.map((existing) => (existing.id === bookmark.id ? bookmark : existing)),
      ),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await fetchJson<void>(bookmarkUrl(id), { method: "DELETE" });
      return id;
    },
    onSuccess: (id) => replaceBookmarks((current) => current.filter((bookmark) => bookmark.id !== id)),
  });

  return { bookmarks: query.data ?? [], isLoading: query.isLoading, isError: query.isError, create, update, remove };
}
