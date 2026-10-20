"use client";

// The catalog's correction guide, opened over the page so the work behind it
// stays where it was.

import { BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { MarkdownContent } from "@/components/markdown-content";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function CorrectionGuideDialog({ body }: { body: string }) {
  const t = useTranslations("correction");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="correction-guide-open">
          <BookOpen className="h-4 w-4" />
          {t("guide")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl" data-testid="correction-guide">
        {/* The guide brings its own heading; the title is for screen readers. */}
        <DialogTitle className="sr-only">{t("guide")}</DialogTitle>
        <DialogDescription className="sr-only">{t("guideDialogDescription")}</DialogDescription>
        <div className="text-sm leading-7">
          <MarkdownContent markdown={body} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
