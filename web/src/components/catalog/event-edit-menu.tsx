"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CalendarDays, ChevronDown, FileText, FolderOpen, Image as ImageIcon, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

interface EventEditMenuProps {
  catalogId: string;
  eventId: number;
  canEditEvent: boolean;
  /** The recording whose metadata the menu edits, or null when there is none or it may not be edited. */
  metadataHash: string | null;
  /** Names the recording when the event has several, so it is clear which one is edited. */
  metadataRecorderName?: string | null;
  canEditArtwork: boolean;
  /** Draft or missing artwork, worth noticing before opening the artwork page. */
  artworkHint?: string | null;
  canManageSources: boolean;
}

interface EditMenuItem {
  href: string;
  icon: ReactNode;
  label: string;
  hint?: string | null;
}

/**
 * Every way to edit an event, behind one button. Each entry keeps its own
 * permission: artwork can be granted without the right to edit the event, so
 * the menu appears whenever any one of them is allowed.
 */
export function EventEditMenu({
  catalogId,
  eventId,
  canEditEvent,
  metadataHash,
  metadataRecorderName,
  canEditArtwork,
  artworkHint,
  canManageSources,
}: EventEditMenuProps) {
  const t = useTranslations("events.detail");
  const eventPath = `/catalog/${catalogId}/event/${eventId}`;
  const iconClass = "h-4 w-4 shrink-0";

  const items: EditMenuItem[] = [];
  if (canEditEvent) {
    items.push({
      href: `${eventPath}/edit`,
      icon: <CalendarDays className={iconClass} />,
      label: t("editMenu.eventDetails"),
    });
  }
  if (metadataHash) {
    items.push({
      href: `/catalog/${catalogId}/recording/${metadataHash}/edit`,
      icon: <FileText className={iconClass} />,
      label: t("editMenu.recordingMetadata"),
      hint: metadataRecorderName,
    });
  }
  if (canEditArtwork) {
    items.push({
      href: `${eventPath}/artwork`,
      icon: <ImageIcon className={iconClass} />,
      label: t("editMenu.artwork"),
      hint: artworkHint,
    });
  }
  if (canManageSources) {
    items.push({
      href: `${eventPath}/sources`,
      icon: <FolderOpen className={iconClass} />,
      label: t("editMenu.sources"),
    });
  }

  if (items.length === 0) return null;

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-2 h-4 w-4" />
          {t("editEvent")}
          <ChevronDown className="ml-2 h-4 w-4" />
        </Button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={t("editEvent")} className="min-w-56">
        {items.map((item) => (
          <ResponsiveMenuItem key={item.href} asChild>
            <Link href={item.href}>
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-xs text-muted-foreground">{item.hint}</span>}
            </Link>
          </ResponsiveMenuItem>
        ))}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
