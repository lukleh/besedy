"use client";

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslations } from "next-intl";
import { Dialog, DialogClose, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ArtworkLightboxImageProps {
  src: string;
  /** Shown enlarged instead of `src`, e.g. the stored original behind a web thumbnail. */
  fullSrc?: string;
  /** Names the image for the enlarge button, the dialog and the alt text. */
  title: string;
  /** Sizes the thumbnail frame, e.g. an aspect-ratio class. */
  className?: string;
}

/** A thumbnail that opens the image fitted to the whole screen. Any click or
 * Escape closes it; the URL does not change. */
export function ArtworkLightboxImage({ src, fullSrc = src, title, className }: ArtworkLightboxImageProps) {
  const t = useTranslations("events.artwork");
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={t("enlarge", { title })}
          className={cn(
            "block w-full cursor-zoom-in overflow-hidden rounded-lg border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={title} className="h-full w-full object-contain" />
        </button>
      </DialogTrigger>
      <DialogPortal>
        <DialogOverlay className="bg-black/90" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          translate="no"
          onClick={() => setOpen(false)}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-4 duration-200 outline-none"
        >
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {/* Fills the viewport box and keeps the aspect ratio, so the image never scrolls. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={fullSrc} alt={title} className="h-full w-full object-contain" />
          <DialogClose className="sr-only">{t("close")}</DialogClose>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
