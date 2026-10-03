"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Pencil, Play, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  USER_BOOKMARKS_QUERY_KEY,
  bookmarkUrl,
  recordingBookmarksQueryKey,
} from "@/hooks/use-recording-bookmarks";
import { fetchJson } from "@/lib/api/fetch-json";
import {
  buildBookmarkHref,
  buildBookmarkRecordingPath,
  recordingBookmarkSchema,
  userBookmarksResponseSchema,
  type BookmarkRecording,
  type UserBookmark,
} from "@/lib/bookmarks/schemas";
import { formatMediumDate, formatPartialDate } from "@/lib/date-format";
import { withBackTo } from "@/lib/navigation/back-to";
import { formatAudioTime } from "@/components/player/audio-player-utils";
import { z } from "zod";
import { BookmarkCommentForm } from "./bookmark-comment-form";
import { DeleteBookmarkButton } from "./delete-bookmark-button";

const BOOKMARKS_PATH = "/bookmarks";
const USER_BOOKMARKS_URL = "/api/bookmarks";

interface RecordingGroup {
  key: string;
  recording: BookmarkRecording;
  bookmarks: UserBookmark[];
}

/** One group per recording, the most recently bookmarked first, each in playback order. */
function groupByRecording(bookmarks: UserBookmark[]): RecordingGroup[] {
  const groups = new Map<string, RecordingGroup>();
  for (const bookmark of bookmarks) {
    const key = `${bookmark.recording.catalogId}/${bookmark.recording.audioHash}`;
    const group = groups.get(key) ?? { key, recording: bookmark.recording, bookmarks: [] };
    group.bookmarks.push(bookmark);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.bookmarks.sort((a, b) => a.positionSec - b.positionSec);
  }
  return [...groups.values()];
}

function matchesFilter(bookmark: UserBookmark, recordingText: string, filter: string): boolean {
  return [bookmark.comment, bookmark.excerpt, recordingText].some((text) =>
    text?.toLocaleLowerCase().includes(filter),
  );
}

/** The recording page's heading: curated title · date · place, else a fallback title. */
function useRecordingHeading() {
  const locale = useLocale();
  return useCallback(
    (recording: BookmarkRecording) => {
      const { dateYear, dateMonth, dateDay } = recording;
      const date = !dateYear
        ? null
        : dateMonth && dateDay
          ? formatMediumDate(dateYear, dateMonth, dateDay, locale)
          : formatPartialDate(dateYear, dateMonth, null, locale);
      const parts = [recording.title, date, recording.locationName].filter(
        (part): part is string => !!part,
      );
      return parts.length > 0
        ? parts.join(" · ")
        : (recording.fallbackTitle ?? recording.audioHash.slice(0, 16));
    },
    [locale],
  );
}

export function BookmarksContent() {
  const t = useTranslations("bookmarks");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const formatHeading = useRecordingHeading();
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: USER_BOOKMARKS_QUERY_KEY,
    queryFn: async () =>
      (await fetchJson(USER_BOOKMARKS_URL, { schema: userBookmarksResponseSchema })).bookmarks,
  });

  const replaceBookmark = (id: string, next: UserBookmark | null) => {
    queryClient.setQueryData<UserBookmark[]>(USER_BOOKMARKS_QUERY_KEY, (current) =>
      (current ?? []).flatMap((bookmark) => (bookmark.id !== id ? [bookmark] : next ? [next] : [])),
    );
  };
  const refreshRecording = (recording: BookmarkRecording) =>
    void queryClient.invalidateQueries({
      queryKey: recordingBookmarksQueryKey(recording.catalogId, recording.audioHash),
    });

  const update = useMutation({
    mutationFn: async ({ bookmark, comment }: { bookmark: UserBookmark; comment: string }) => {
      const response = await fetchJson(bookmarkUrl(bookmark.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
        schema: z.object({ bookmark: recordingBookmarkSchema }),
      });
      return { ...response.bookmark, recording: bookmark.recording };
    },
    onSuccess: (bookmark) => {
      replaceBookmark(bookmark.id, bookmark);
      refreshRecording(bookmark.recording);
      setEditingId(null);
    },
    onError: () => toast({ title: t("saveFailed"), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (bookmark: UserBookmark) => {
      await fetchJson<void>(bookmarkUrl(bookmark.id), { method: "DELETE" });
      return bookmark;
    },
    onSuccess: (bookmark) => {
      replaceBookmark(bookmark.id, null);
      refreshRecording(bookmark.recording);
    },
    onError: () => toast({ title: t("deleteFailed"), variant: "destructive" }),
  });

  const bookmarks = data ?? [];
  const showCatalog = new Set(bookmarks.map((bookmark) => bookmark.recording.catalogId)).size > 1;
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const all = groupByRecording(data ?? []);
    if (!normalizedFilter) return all;
    return all
      .map((group) => {
        const recordingText = `${formatHeading(group.recording)} ${group.recording.catalogLabel ?? ""}`;
        return {
          ...group,
          bookmarks: group.bookmarks.filter((bookmark) =>
            matchesFilter(bookmark, recordingText, normalizedFilter),
          ),
        };
      })
      .filter((group) => group.bookmarks.length > 0);
  }, [data, normalizedFilter, formatHeading]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Bookmark className="h-6 w-6" aria-hidden="true" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      {bookmarks.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("filterPlaceholder")}
            aria-label={t("filterPlaceholder")}
            className="pl-9"
            data-testid="bookmarks-filter"
          />
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      )}

      {isError && <p className="text-sm text-destructive">{t("loadFailed")}</p>}

      {!isLoading && !isError && bookmarks.length === 0 && (
        <div className="rounded-lg border p-8 text-center text-sm text-muted-foreground" data-testid="bookmarks-empty">
          {t("empty")}
        </div>
      )}

      {bookmarks.length > 0 && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("noMatches")}</p>
      )}

      <div className="space-y-4">
        {groups.map((group) => {
          const heading = formatHeading(group.recording);
          const recordingHref = withBackTo(buildBookmarkRecordingPath(group.recording), BOOKMARKS_PATH);
          return (
            <Card key={group.key} className="py-0" data-testid="bookmarks-recording">
              <CardContent className="space-y-3 p-4">
                <div className="min-w-0">
                  <Link href={recordingHref} className="block break-words font-medium hover:underline">
                    {heading}
                  </Link>
                  {showCatalog && group.recording.catalogLabel && (
                    <p className="truncate text-sm text-muted-foreground">{group.recording.catalogLabel}</p>
                  )}
                </div>
                <ul className="divide-y">
                  {group.bookmarks.map((bookmark) => (
                    <li key={bookmark.id} className="flex items-start gap-2 py-2" data-testid="bookmark-item">
                      <Button variant="secondary" size="sm" className="shrink-0 font-mono tabular-nums" asChild>
                        <Link
                          href={withBackTo(buildBookmarkHref(bookmark.recording, bookmark.positionSec), BOOKMARKS_PATH)}
                          title={t("playFrom")}
                          data-testid="bookmark-open"
                        >
                          <Play className="mr-1 h-3.5 w-3.5" />
                          {formatAudioTime(bookmark.positionSec)}
                        </Link>
                      </Button>
                      <div className="min-w-0 flex-1 space-y-1 pt-1">
                        {editingId === bookmark.id ? (
                          <BookmarkCommentForm
                            label={t("comment")}
                            initialComment={bookmark.comment ?? ""}
                            isSaving={update.isPending}
                            onCancel={() => setEditingId(null)}
                            onSave={(comment) => update.mutate({ bookmark, comment })}
                          />
                        ) : (
                          <>
                            {bookmark.comment && (
                              <p className="whitespace-pre-wrap break-words text-sm">{bookmark.comment}</p>
                            )}
                            {bookmark.excerpt && (
                              <p className="line-clamp-2 text-sm italic text-muted-foreground">
                                „{bookmark.excerpt}“
                              </p>
                            )}
                          </>
                        )}
                      </div>
                      {editingId !== bookmark.id && (
                        <div className="flex shrink-0 items-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9"
                            onClick={() => setEditingId(bookmark.id)}
                            title={t("editComment")}
                            aria-label={t("editComment")}
                            data-testid="bookmark-edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <DeleteBookmarkButton
                            disabled={remove.isPending}
                            onDelete={() => remove.mutate(bookmark)}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
