"use client";

import Link from "next/link";
import { Sparkles, Telescope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DeepSearchActionProps {
  href: string;
  label: string;
  className?: string;
}

export function DeepSearchIconAction({
  href,
  label,
  className,
}: DeepSearchActionProps) {
  return (
    <Button
      asChild
      variant="outline"
      size="icon"
      className={cn(
        "relative overflow-hidden border-primary/30 bg-primary/5 text-primary hover:bg-primary/10",
        className,
      )}
    >
      <Link href={href} aria-label={label} title={label}>
        <Telescope className="size-4" />
        <Sparkles className="absolute right-1.5 top-1.5 size-2.5" />
      </Link>
    </Button>
  );
}

export function DeepSearchAction({
  href,
  label,
  className,
}: DeepSearchActionProps) {
  return (
    <Button
      asChild
      variant="outline"
      className={cn(
        "h-auto min-h-[66px] w-full justify-start overflow-hidden border-primary/25 bg-background px-3 py-2 text-left shadow-xs hover:border-primary/45 hover:bg-primary/5 @[900px]/catalog:w-[15rem]",
        className,
      )}
    >
      <Link href={href} aria-label={label} title={label}>
        <span className="relative flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Telescope className="size-5" />
          <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-background text-primary shadow-sm">
            <Sparkles className="size-3" />
          </span>
        </span>
        <span className="min-w-0 truncate">{label}</span>
      </Link>
    </Button>
  );
}
