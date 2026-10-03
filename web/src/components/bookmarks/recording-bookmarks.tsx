"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { BookmarkPlus, List, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import type { useRecordingBookmarks } from "@/hooks/use-recording-bookmarks";
import { BOOKMARK_EXCERPT_MAX_LENGTH, type RecordingBookmark } from "@/lib/bookmarks/schemas";
import { formatAudioTime } from "@/components/player/audio-player-utils";
import { BookmarkCommentForm } from "./bookmark-comment-form";
import { DeleteBookmarkButton } from "./delete-bookmark-button";

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

/**
 * The transcript line being spoken at `time`, or the last one before it when
 * `time` falls in a pause, so the bookmark remembers what was said there.
 */
export function findTranscriptExcerpt(lines: readonly TranscriptLine[], time: number): string | null {
  let match: TranscriptLine | null = null;
  for (const line of lines) {
    if (line.start > time) break;
    match = line;
    if (time < line.end) break;
  }
  const text = match?.text.trim();
  return text ? text.slice(0, BOOKMARK_EXCERPT_MAX_LENGTH) : null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

interface RecordingBookmarksProps {
  bookmarks: ReturnType<typeof useRecordingBookmarks>;
  currentTime: number;
  onSeek: (time: number) => void;
  transcriptLines: readonly TranscriptLine[];
}

/** The listener's own bookmarks in this recording, under the player. */
export function RecordingBookmarks({
  bookmarks,
  currentTime,
  onSeek,
  transcriptLines,
}: RecordingBookmarksProps) {
  const t = useTranslations("bookmarks");
  const { toast } = useToast();
  // The moment is taken when the listener asks for the bookmark, not when the
  // comment is saved; playback carries on while they type.
  const [draftTime, setDraftTime] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const startDraft = () => {
    setEditingId(null);
    setDraftTime(currentTimeRef.current);
  };

  // B adds a bookmark, like the player's own shortcuts outside text fields.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyB" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      setEditingId(null);
      setDraftTime(currentTimeRef.current);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const showError = () => toast({ title: t("saveFailed"), variant: "destructive" });

  const saveDraft = (comment: string) => {
    if (draftTime === null) return;
    bookmarks.create.mutate(
      {
        positionSec: draftTime,
        comment,
        excerpt: findTranscriptExcerpt(transcriptLines, draftTime),
      },
      { onSuccess: () => setDraftTime(null), onError: showError },
    );
  };

  const saveEdit = (bookmark: RecordingBookmark, comment: string) => {
    bookmarks.update.mutate(
      { id: bookmark.id, comment },
      { onSuccess: () => setEditingId(null), onError: showError },
    );
  };

  const deleteBookmark = (bookmark: RecordingBookmark) => {
    bookmarks.remove.mutate(bookmark.id, {
      onError: () => toast({ title: t("deleteFailed"), variant: "destructive" }),
    });
  };

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="recording-bookmarks-heading" data-testid="recording-bookmarks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recording-bookmarks-heading" className="text-base font-semibold">
          {t("title")}
          {bookmarks.bookmarks.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{bookmarks.bookmarks.length}</span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/bookmarks">
              <List className="mr-2 h-4 w-4" />
              {t("all")}
            </Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={startDraft}
            title={t("addShortcut")}
            data-testid="bookmark-add"
          >
            <BookmarkPlus className="mr-2 h-4 w-4" />
            {t("add")}
          </Button>
        </div>
      </div>

      {draftTime !== null && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3" data-testid="bookmark-draft">
          <p className="text-sm font-medium">{t("newAt", { time: formatAudioTime(draftTime) })}</p>
          <BookmarkCommentForm
            label={t("comment")}
            isSaving={bookmarks.create.isPending}
            onCancel={() => setDraftTime(null)}
            onSave={saveDraft}
          />
        </div>
      )}

      {bookmarks.bookmarks.length === 0 && draftTime === null && !bookmarks.isLoading && (
        <p className="text-sm text-muted-foreground">
          {bookmarks.isError ? t("loadFailed") : t("emptyRecording")}
        </p>
      )}

      {bookmarks.bookmarks.length > 0 && (
        <ul className="divide-y">
          {bookmarks.bookmarks.map((bookmark) => (
            <li key={bookmark.id} className="flex items-start gap-2 py-2" data-testid="bookmark-item">
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 font-mono tabular-nums"
                onClick={() => onSeek(bookmark.positionSec)}
                title={t("playFrom")}
                data-testid="bookmark-seek"
              >
                {formatAudioTime(bookmark.positionSec)}
              </Button>
              <div className="min-w-0 flex-1 space-y-1 pt-1">
                {editingId === bookmark.id ? (
                  <BookmarkCommentForm
                    label={t("comment")}
                    initialComment={bookmark.comment ?? ""}
                    isSaving={bookmarks.update.isPending}
                    onCancel={() => setEditingId(null)}
                    onSave={(comment) => saveEdit(bookmark, comment)}
                  />
                ) : (
                  <>
                    {bookmark.comment && (
                      <p className="whitespace-pre-wrap break-words text-sm">{bookmark.comment}</p>
                    )}
                    {bookmark.excerpt && (
                      <p className="line-clamp-2 text-sm italic text-muted-foreground">„{bookmark.excerpt}“</p>
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
                    onClick={() => {
                      setDraftTime(null);
                      setEditingId(bookmark.id);
                    }}
                    title={t("editComment")}
                    aria-label={t("editComment")}
                    data-testid="bookmark-edit"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <DeleteBookmarkButton
                    disabled={bookmarks.remove.isPending}
                    onDelete={() => deleteBookmark(bookmark)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
