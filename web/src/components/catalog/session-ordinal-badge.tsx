"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface SessionOrdinalBadgeProps {
  sessionOrdinal: number | undefined;
  /** Events sharing this location and date. Undefined on older offline records. */
  sessionCount: number | undefined;
  className?: string;
}

/**
 * Marks every event of a day that holds more than one, the first included.
 * Labelling only the second reads as if it were the odd one out, when in fact
 * neither is: they are two sittings of an ordinary day.
 *
 * `h-5` keeps the badge inside the 20px line box a table row gives it and
 * inside the 56px text slot a mobile card reserves, so a marked row is exactly
 * as tall as an unmarked one.
 */
export function SessionOrdinalBadge({
  sessionOrdinal,
  sessionCount,
  className,
}: SessionOrdinalBadgeProps) {
  const t = useTranslations("events.session");

  if (!sessionOrdinal || !sessionCount || sessionCount <= 1) return null;

  const spoken = t("ordinalAria", { index: sessionOrdinal, count: sessionCount });

  return (
    <Badge
      variant="outline"
      title={spoken}
      data-testid="session-ordinal"
      className={cn(
        "h-5 shrink-0 px-2 py-0 leading-none align-middle tabular-nums",
        className
      )}
    >
      <span aria-hidden="true">
        {t("ordinal", { index: sessionOrdinal, count: sessionCount })}
      </span>
      <span className="sr-only">{spoken}</span>
    </Badge>
  );
}
