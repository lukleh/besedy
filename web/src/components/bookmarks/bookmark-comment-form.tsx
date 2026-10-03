"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { BOOKMARK_COMMENT_MAX_LENGTH } from "@/lib/bookmarks/schemas";

interface BookmarkCommentFormProps {
  initialComment?: string;
  isSaving: boolean;
  label: string;
  onCancel: () => void;
  onSave: (comment: string) => void;
}

/** The comment of a new or existing bookmark. Ctrl/⌘+Enter saves, Escape cancels. */
export function BookmarkCommentForm({
  initialComment = "",
  isSaving,
  label,
  onCancel,
  onSave,
}: BookmarkCommentFormProps) {
  const t = useTranslations("bookmarks");
  const tCommon = useTranslations("common");
  const [comment, setComment] = useState(initialComment);
  // The button is disabled while saving; the keyboard and submit paths must
  // not send a second request either.
  const save = () => {
    if (!isSaving) onSave(comment);
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Textarea
        autoFocus
        aria-label={label}
        placeholder={t("commentPlaceholder")}
        maxLength={BOOKMARK_COMMENT_MAX_LENGTH}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        data-testid="bookmark-comment-input"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={isSaving}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={isSaving} data-testid="bookmark-save">
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {tCommon("save")}
        </Button>
      </div>
    </form>
  );
}
