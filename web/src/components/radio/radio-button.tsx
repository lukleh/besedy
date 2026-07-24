"use client";

import { Radio, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useRadioMode } from "@/contexts/radio-mode-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface RadioButtonProps {
  catalogId: string | null;
}

// Check if we're on a recording detail page
function isRecordingDetailPage(pathname: string): boolean {
  // Pattern: /catalog/[catalogId]/recording/[hash]
  return /^\/catalog\/[^/]+\/recording\/[^/]+$/.test(pathname);
}

export function RadioButton({ catalogId }: RadioButtonProps) {
  const t = useTranslations("radio");
  const pathname = usePathname();
  const router = useRouter();
  const { isActive, isLoading, startRadio, stopRadio } = useRadioMode();

  const handleClick = () => {
    if (isActive) {
      stopRadio();
    } else if (catalogId) {
      // If on recording detail page, redirect to catalog view first
      // Delay radio start to let the recording page's audio player clean up
      if (isRecordingDetailPage(pathname)) {
        router.push(`/catalog/${catalogId}`);
        setTimeout(() => startRadio(catalogId), 100);
      } else {
        startRadio(catalogId);
      }
    }
  };

  const isDisabled = !catalogId || (isLoading && !isActive);
  const title = isActive ? t("stop") : t("start");

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      disabled={isDisabled}
      className={cn(
        "relative",
        isActive && "animate-pulse-radio text-primary"
      )}
      aria-label={title}
      title={title}
    >
      {isLoading && !isActive ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Radio className="h-5 w-5" />
      )}
    </Button>
  );
}
