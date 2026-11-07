"use client";

import { Check, MoonStar } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { useSleepTimer } from "@/contexts/sleep-timer-context";
import { SLEEP_TIMER_MINUTES } from "@/lib/sleep-timer/countdown";
import { cn } from "@/lib/utils";

/** Time left as m:ss, rounded up so it never shows 0:00 while running. */
export function formatSleepRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function SleepTimerOption({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <ResponsiveMenuItem onSelect={onSelect}>
      <span className="flex size-4 items-center justify-center">
        {checked && <Check className="size-4" />}
      </span>
      {children}
    </ResponsiveMenuItem>
  );
}

/** Sets, shows and turns off the shared sleep timer. */
export function SleepTimerButton() {
  const t = useTranslations("sleepTimer");
  const timer = useSleepTimer();
  if (!timer) return null;

  const { minutes, remainingMs, start, cancel } = timer;
  const remaining =
    remainingMs !== null ? formatSleepRemaining(remainingMs) : null;

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          // The name stays fixed so screen readers do not re-read it every
          // second; the time left is in the visible text and the tooltip.
          title={remaining !== null ? t("activeLabel", { time: remaining }) : t("label")}
          aria-label={t("label")}
          data-testid="sleep-timer-button"
          className={cn(
            "flex-col gap-0 h-12 w-12 sm:h-14 sm:w-14",
            remaining !== null && "text-primary",
          )}
        >
          <MoonStar className="size-6" />
          {remaining !== null && (
            <span
              className="text-[10px] font-semibold leading-none tabular-nums"
              data-testid="sleep-timer-remaining"
            >
              {remaining}
            </span>
          )}
        </Button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent title={t("label")} className="min-w-40">
        <SleepTimerOption checked={minutes === null} onSelect={cancel}>
          {t("off")}
        </SleepTimerOption>
        {SLEEP_TIMER_MINUTES.map((option) => (
          // Choosing the running duration again starts it over.
          <SleepTimerOption
            key={option}
            checked={minutes === option}
            onSelect={() => start(option)}
          >
            {t("minutes", { count: option })}
          </SleepTimerOption>
        ))}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
