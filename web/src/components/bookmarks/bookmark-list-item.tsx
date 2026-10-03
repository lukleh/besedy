"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RecordingBookmark } from "@/lib/bookmarks/schemas";
import { BookmarkCommentForm } from "./bookmark-comment-form";
import { DeleteBookmarkButton } from "./delete-bookmark-button";

interface BookmarkListItemProps {
  bookmark: RecordingBookmark;
  /** What the time does: seek in the open recording, or open the recording. */
  timeControl: ReactNode;
  isEditing: boolean;
  isSaving: boolean;
  isDeleting: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (comment: string) => void;
  onDelete: () => void;
}

/** One bookmark: its time, comment and transcript line, with edit and delete. */
export function BookmarkListItem({
  bookmark,
  timeControl,
  isEditing,
  isSaving,
  isDeleting,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: BookmarkListItemProps) {
  const t = useTranslations("bookmarks");

  return (
    <li className="flex items-start gap-2 py-2" data-testid="bookmark-item">
      {timeControl}
      <div className="min-w-0 flex-1 space-y-1 pt-1">
        {isEditing ? (
          <BookmarkCommentForm
            label={t("comment")}
            initialComment={bookmark.comment ?? ""}
            isSaving={isSaving}
            onCancel={onCancelEdit}
            onSave={onSave}
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
      {!isEditing && (
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={onEdit}
            title={t("editComment")}
            aria-label={t("editComment")}
            data-testid="bookmark-edit"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <DeleteBookmarkButton disabled={isDeleting} onDelete={onDelete} />
        </div>
      )}
    </li>
  );
}
