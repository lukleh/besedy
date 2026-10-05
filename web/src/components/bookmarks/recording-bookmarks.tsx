"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { List } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useReturnHref } from "@/hooks/use-return-href";
import type { useRecordingBookmarks } from "@/hooks/use-recording-bookmarks";
import { BOOKMARK_EXCERPT_MAX_LENGTH, type RecordingBookmark } from "@/lib/bookmarks/schemas";
import { formatAudioTime } from "@/components/player/audio-player-utils";
import { BookmarkCommentForm } from "./bookmark-comment-form";
import { BookmarkListItem } from "./bookmark-list-item";

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
}

/**
 * The transcript line being spoken at `time` (the one the transcript viewer
 * highlights), or the latest one to start before it when `time` falls in a
 * pause, so the bookmark remembers what was said there. Model output is not
 * guaranteed to be sorted or free of overlaps, so every line is checked.
 */
export function findTranscriptExcerpt(lines: readonly TranscriptLine[], time: number): string | null {
  const spoken = lines.find((line) => time >= line.start && time < line.end);
  let before: TranscriptLine | null = null;
  for (const line of lines) {
    if (line.start <= time && (!before || line.start > before.start)) before = line;
  }
  const text = (spoken ?? before)?.text.trim();
  return text ? text.slice(0, BOOKMARK_EXCERPT_MAX_LENGTH) : null;
}

/**
 * Keys meant for something else: text fields, and the dialogs, menus, lists
 * and sliders that use letters or arrows themselves.
 */
function isOwnedByOtherControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="slider"]') !== null
  );
}

export interface BookmarkDraft {
  /** The moment of the bookmark being written, or null when none is. */
  draftTime: number | null;
  /** The bookmark whose comment is being edited. */
  editingId: string | null;
  startDraft: () => void;
  cancelDraft: () => void;
  startEdit: (id: string) => void;
  stopEdit: () => void;
}

/**
 * Writing a bookmark. The moment is taken when the listener asks for the
 * bookmark (the player's button or the B key), not when the comment is saved;
 * playback carries on while they type. One form is open at a time.
 */
export function useBookmarkDraft(currentTime: number, enabled: boolean): BookmarkDraft {
  const [draftTime, setDraftTime] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const startDraft = useCallback(() => {
    setEditingId(null);
    setDraftTime(currentTimeRef.current);
  }, []);
  const cancelDraft = useCallback(() => setDraftTime(null), []);
  const startEdit = useCallback((id: string) => {
    setDraftTime(null);
    setEditingId(id);
  }, []);
  const stopEdit = useCallback(() => setEditingId(null), []);

  // B adds a bookmark, like the player's own shortcuts outside text fields.
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "KeyB" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isOwnedByOtherControl(event.target)
      ) {
        return;
      }
      event.preventDefault();
      startDraft();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, startDraft]);

  return { draftTime, editingId, startDraft, cancelDraft, startEdit, stopEdit };
}

interface RecordingBookmarksProps {
  bookmarks: ReturnType<typeof useRecordingBookmarks>;
  draft: BookmarkDraft;
  onSeek: (time: number) => void;
  transcriptLines: readonly TranscriptLine[];
}

/**
 * The listener's own bookmarks in this recording, under the player. Nothing is
 * shown until there is a bookmark or one is being written; the player's
 * bookmark button starts one.
 */
export function RecordingBookmarks({
  bookmarks,
  draft,
  onSeek,
  transcriptLines,
}: RecordingBookmarksProps) {
  const t = useTranslations("bookmarks");
  const { toast } = useToast();
  const allBookmarksHref = useReturnHref("/bookmarks");
  const { draftTime, editingId } = draft;

  const showError = () => toast({ title: t("saveFailed"), variant: "destructive" });

  const saveDraft = (comment: string) => {
    if (draftTime === null) return;
    bookmarks.create.mutate(
      {
        positionSec: draftTime,
        comment,
        excerpt: findTranscriptExcerpt(transcriptLines, draftTime),
      },
      { onSuccess: draft.cancelDraft, onError: showError },
    );
  };

  const saveEdit = (bookmark: RecordingBookmark, comment: string) => {
    bookmarks.update.mutate(
      { id: bookmark.id, comment },
      { onSuccess: draft.stopEdit, onError: showError },
    );
  };

  const deleteBookmark = (bookmark: RecordingBookmark) => {
    bookmarks.remove.mutate(bookmark.id, {
      onError: () => toast({ title: t("deleteFailed"), variant: "destructive" }),
    });
  };

  if (bookmarks.bookmarks.length === 0 && draftTime === null) return null;

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="recording-bookmarks-heading" data-testid="recording-bookmarks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="recording-bookmarks-heading" className="text-base font-semibold">
          {t("title")}
          {bookmarks.bookmarks.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{bookmarks.bookmarks.length}</span>
          )}
        </h2>
        <Button variant="ghost" size="sm" asChild>
          <Link href={allBookmarksHref}>
            <List className="mr-2 h-4 w-4" />
            {t("all")}
          </Link>
        </Button>
      </div>

      {draftTime !== null && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3" data-testid="bookmark-draft">
          <p className="text-sm font-medium">{t("newAt", { time: formatAudioTime(draftTime) })}</p>
          <BookmarkCommentForm
            label={t("comment")}
            isSaving={bookmarks.create.isPending}
            onCancel={draft.cancelDraft}
            onSave={saveDraft}
          />
        </div>
      )}

      {bookmarks.bookmarks.length > 0 && (
        <ul className="divide-y">
          {bookmarks.bookmarks.map((bookmark) => (
            <BookmarkListItem
              key={bookmark.id}
              bookmark={bookmark}
              timeControl={
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
              }
              isEditing={editingId === bookmark.id}
              isSaving={bookmarks.update.isPending}
              isDeleting={bookmarks.remove.isPending}
              onEdit={() => draft.startEdit(bookmark.id)}
              onCancelEdit={draft.stopEdit}
              onSave={(comment) => saveEdit(bookmark, comment)}
              onDelete={() => deleteBookmark(bookmark)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
