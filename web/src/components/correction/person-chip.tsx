"use client";

import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

/** Up to two initials; a person without a name is a question mark. */
export function initialsOf(name: string | null): string {
  const words = (name ?? "").split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? [...words[0]].slice(0, 2) : [[...words[0]][0], [...words[words.length - 1]][0]];
  return letters.join("").toUpperCase();
}

interface PersonChipProps {
  name: string | null;
  /** The person has unsaved wording on the segment the chip marks */
  editing: boolean;
}

/** Somebody else who has the recording open right now, as a small badge. */
export function PersonChip({ name, editing }: PersonChipProps) {
  const t = useTranslations("correction");
  const shown = name ?? t("unknownActor");
  const label = t(editing ? "presence.editing" : "presence.here", { name: shown });

  return (
    <span
      title={label}
      data-testid="correction-person-chip"
      data-editing={editing || undefined}
      className={`inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold leading-none text-white ${
        editing ? "bg-amber-600" : "bg-sky-600"
      }`}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
      {editing && <Pencil className="h-2.5 w-2.5" aria-hidden="true" />}
      <span className="sr-only">{label}</span>
    </span>
  );
}
