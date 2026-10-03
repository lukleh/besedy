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

interface SleepTimerButtonProps {
  /** `player`: the recording player's control row; `banner`: the radio bar. */
  variant: "player" | "banner";
}

/** Sets, shows and turns off the shared sleep timer. */
export function SleepTimerButton({ variant }: SleepTimerButtonProps) {
  const t = useTranslations("sleepTimer");
  const timer = useSleepTimer();
  if (!timer) return null;

  const { minutes, remainingMs, start, cancel } = timer;
  const remaining =
    remainingMs !== null ? formatSleepRemaining(remainingMs) : null;
  const label =
    remaining !== null ? t("activeLabel", { time: remaining }) : t("label");

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          title={label}
          aria-label={label}
          data-testid="sleep-timer-button"
          className={cn(
            "flex-col gap-0",
            variant === "player" ? "h-12 w-12 sm:h-14 sm:w-14" : "h-9 w-auto min-w-9 px-1",
            remaining !== null && "text-primary",
          )}
        >
          <MoonStar className={variant === "player" ? "size-6" : "h-5 w-5"} />
          {remaining !== null && (
            <span
              className={cn(
                "text-[10px] font-semibold leading-none tabular-nums",
                // The radio bar is too narrow on phones for the time.
                variant === "banner" && "hidden sm:inline",
              )}
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
