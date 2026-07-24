"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, Bell, BellOff, FlaskConical, Loader2, Palette, Languages, ALargeSmall } from "lucide-react";
import { useTheme } from "next-themes";
import { useToast } from "@/hooks/use-toast";
import { useLabs } from "@/hooks/use-labs";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { useTextSize, type TextSize } from "@/contexts/text-size-context";
import { getFeatureRollout } from "@/lib/features/rollout";
import { routing, type Locale } from "@/i18n/routing";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const THEME_OPTIONS = ["light", "dark", "system"] as const;
const TEXT_SIZE_OPTIONS: TextSize[] = ["default", "large", "xlarge"];
const NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  cs: "Čeština",
};
const SHOW_LABS_FEATURE_LIST = getFeatureRollout("events") === "labs";

export default function SettingsPage() {
  const locale = useLocale() as Locale;
  const router = useRouter();
  const t = useTranslations("notifications");
  const tLabs = useTranslations("labs");
  const tTheme = useTranslations("theme");
  const tLanguage = useTranslations("language");
  const tTextSize = useTranslations("textSize");
  const tNav = useTranslations("nav");
  const { toast } = useToast();
  const { theme, setTheme } = useTheme();
  const { textSize, setTextSize } = useTextSize();
  const [isLocalePending, startLocaleTransition] = useTransition();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);
  const { labsEnabled, isUpdating, updateLabsEnabledAsync } = useLabs();
  const {
    permission,
    isSupported,
    isSubscribed,
    isLoading,
    error,
    subscribe,
    unsubscribe,
  } = usePushNotifications();
  const currentTheme = (theme ?? "system") as (typeof THEME_OPTIONS)[number];

  useEffect(() => {
    if (!pendingLocale) return;
    document.cookie = `NEXT_LOCALE=${pendingLocale};path=/;max-age=31536000;samesite=lax`;
    startLocaleTransition(() => {
      router.refresh();
      setPendingLocale(null);
    });
  }, [pendingLocale, router, startLocaleTransition]);

  const handleToggle = async () => {
    if (isSubscribed) {
      const success = await unsubscribe();
      if (success) {
        toast({ title: t("unsubscribedToast") });
      }
    } else {
      const success = await subscribe();
      if (success) {
        toast({ title: t("subscribedToast") });
      }
    }
  };

  const handleLabsToggle = async (nextEnabled: boolean) => {
    try {
      await updateLabsEnabledAsync(nextEnabled);
      toast({
        title: nextEnabled ? tLabs("enabledToast") : tLabs("disabledToast"),
      });
    } catch (error) {
      toast({
        title: tLabs("updateFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  const handleLocaleChange = (value: string) => {
    const nextLocale = value as Locale;
    if (nextLocale !== locale) {
      setPendingLocale(nextLocale);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToCatalog")}
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("settingsTitle")}</h1>
        <p className="text-muted-foreground">{t("settingsDescription")}</p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="h-5 w-5" />
              {t("appearance")}
            </CardTitle>
            <CardDescription>{t("appearanceDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="theme-select" className="text-base">
                {tNav("toggleTheme")}
              </Label>
              <p className="text-sm text-muted-foreground">{t("themeDescription")}</p>
              <Select
                value={currentTheme}
                onValueChange={(value) => setTheme(value as (typeof THEME_OPTIONS)[number])}
              >
                <SelectTrigger id="theme-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THEME_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {tTheme(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="language-select" className="text-base">
                <span className="inline-flex items-center gap-2">
                  <Languages className="h-4 w-4" />
                  {tLanguage("title")}
                </span>
              </Label>
              <p className="text-sm text-muted-foreground">{t("languageDescription")}</p>
              <Select
                value={locale}
                onValueChange={handleLocaleChange}
                disabled={isLocalePending}
              >
                <SelectTrigger id="language-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {routing.locales.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {NATIVE_NAMES[loc]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="text-size-select" className="text-base">
                <span className="inline-flex items-center gap-2">
                  <ALargeSmall className="h-4 w-4" />
                  {tTextSize("toggle")}
                </span>
              </Label>
              <p className="text-sm text-muted-foreground">{t("textSizeDescription")}</p>
              <Select
                value={textSize}
                onValueChange={(value) => setTextSize(value as TextSize)}
              >
                <SelectTrigger id="text-size-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_SIZE_OPTIONS.map((size) => (
                    <SelectItem key={size} value={size}>
                      {tTextSize(size)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card id="notifications">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="h-5 w-5" />
              {t("pushNotifications")}
            </CardTitle>
            <CardDescription>{t("pushDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isSupported ? (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-muted">
                <BellOff className="h-5 w-5 text-muted-foreground" />
                <div>
                  <p className="font-medium">{t("notSupported")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("notSupportedDescription")}
                  </p>
                </div>
              </div>
            ) : permission === "denied" ? (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10">
                <BellOff className="h-5 w-5 text-destructive" />
                <div>
                  <p className="font-medium text-destructive">{t("permissionDenied")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("permissionDeniedDescription")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="push-toggle" className="text-base">
                    {t("enablePush")}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("enablePushDescription")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Switch
                    id="push-toggle"
                    checked={isSubscribed}
                    onCheckedChange={handleToggle}
                    disabled={isLoading}
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            {isSubscribed && (
              <div className="p-3 rounded-lg bg-green-500/10 text-green-700 dark:text-green-400 text-sm">
                {t("subscribed")}
              </div>
            )}

            <div className="border-t pt-4 text-sm text-muted-foreground space-y-2">
              <h4 className="font-medium text-foreground">{t("about")}</h4>
              <p>{t("aboutDescription")}</p>
              <ul className="list-disc list-inside space-y-1">
                <li>{t("aboutItem1")}</li>
                <li>{t("aboutItem2")}</li>
                <li>{t("aboutItem3")}</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-5 w-5" />
              {tLabs("title")}
            </CardTitle>
            <CardDescription>{tLabs("description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="labs-toggle" className="text-base">
                    {tLabs("toggleLabel")}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {tLabs("toggleDescription")}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isUpdating && <Loader2 className="h-4 w-4 animate-spin" />}
                  <Switch
                    id="labs-toggle"
                    checked={labsEnabled}
                    onCheckedChange={handleLabsToggle}
                    disabled={isUpdating}
                  />
                </div>
              </div>

              {SHOW_LABS_FEATURE_LIST ? (
                <div className="border-t pt-4 space-y-2">
                  <p className="text-sm font-medium">{tLabs("availableFeaturesTitle")}</p>
                  <div className="rounded-lg border bg-muted/30 p-3">
                    <p className="text-sm font-medium">{tLabs("eventsFeatureTitle")}</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {tLabs("eventsFeatureDescription")}
                    </p>
                    <ul className="mt-2 list-disc list-inside space-y-1 text-sm text-muted-foreground">
                      <li>{tLabs("eventsFeatureViewDetail")}</li>
                      <li>{tLabs("eventsFeatureEditDetail")}</li>
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
