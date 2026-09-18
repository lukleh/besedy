"use client";

import { Loader2, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type {
  CatalogConfig,
  CatalogConfigDraft,
} from "./catalog-settings-content-types";

interface CatalogSettingsConfigCardProps {
  catalogConfig?: CatalogConfig;
  configDraft: CatalogConfigDraft | null;
  configError: Error | null;
  isEditing: boolean;
  isLoading: boolean;
  isSyncPending: boolean;
  isUpdatePending: boolean;
  onCancelEditing: () => void;
  onDraftChange: (updater: (draft: CatalogConfigDraft) => CatalogConfigDraft) => void;
  onSave: () => void;
  onStartEditing: () => void;
  onSync: () => void;
}

export function CatalogSettingsConfigCard({
  catalogConfig,
  configDraft,
  configError,
  isEditing,
  isLoading,
  isSyncPending,
  isUpdatePending,
  onCancelEditing,
  onDraftChange,
  onSave,
  onStartEditing,
  onSync,
}: CatalogSettingsConfigCardProps) {
  const t = useTranslations("catalogSettings");
  const tCommon = useTranslations("common");

  const updateDraft = (
    updater: (draft: CatalogConfigDraft) => CatalogConfigDraft
  ) => {
    onDraftChange(updater);
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <CardTitle>{t("configuration.title")}</CardTitle>
          <CardDescription>{t("configuration.description")}</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onSync}
            disabled={isSyncPending}
          >
            {isSyncPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("buttons.syncCatalog")}
          </Button>
          {isEditing ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onSave}
                disabled={isUpdatePending}
              >
                {isUpdatePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {tCommon("save")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onCancelEditing}
                disabled={isUpdatePending}
              >
                {tCommon("cancel")}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={onStartEditing}>
              <Pencil className="mr-2 h-4 w-4" />
              {tCommon("edit")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {configError ? (
          <div className="text-sm text-destructive">
            {configError.message || t("configuration.loadError")}
          </div>
        ) : isLoading || !configDraft ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="config-id">{t("configuration.catalogId")}</Label>
                <Input id="config-id" value={catalogConfig?.id ?? ""} disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="config-label">{t("configuration.label")}</Label>
                <Input
                  id="config-label"
                  value={configDraft.label}
                  onChange={(event) =>
                    updateDraft((draft) => ({ ...draft, label: event.target.value }))
                  }
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="archived-path">{t("configuration.archivedPath")}</Label>
                <Input
                  id="archived-path"
                  value={configDraft.archivedCatalogPath}
                  onChange={(event) =>
                    updateDraft((draft) => ({
                      ...draft,
                      archivedCatalogPath: event.target.value,
                    }))
                  }
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="metadata-path">{t("configuration.metadataPath")}</Label>
                <Input
                  id="metadata-path"
                  value={configDraft.metadataCatalogPath}
                  onChange={(event) =>
                    updateDraft((draft) => ({
                      ...draft,
                      metadataCatalogPath: event.target.value,
                    }))
                  }
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="duplicates-path">{t("configuration.duplicatesPath")}</Label>
                <Input
                  id="duplicates-path"
                  value={configDraft.duplicatesCatalogPath}
                  onChange={(event) =>
                    updateDraft((draft) => ({
                      ...draft,
                      duplicatesCatalogPath: event.target.value,
                    }))
                  }
                  disabled={!isEditing}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="transcripts-path">{t("configuration.transcriptsPath")}</Label>
                <Input
                  id="transcripts-path"
                  value={configDraft.transcriptsPath}
                  onChange={(event) =>
                    updateDraft((draft) => ({
                      ...draft,
                      transcriptsPath: event.target.value,
                    }))
                  }
                  disabled={!isEditing}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  id="config-active"
                  checked={configDraft.isActive}
                  onCheckedChange={(value) =>
                    updateDraft((draft) => ({ ...draft, isActive: value }))
                  }
                  disabled={!isEditing}
                />
                <Label htmlFor="config-active">{t("configuration.active")}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="config-default"
                  checked={configDraft.isDefault}
                  onCheckedChange={(value) =>
                    updateDraft((draft) => ({ ...draft, isDefault: value }))
                  }
                  disabled={!isEditing}
                />
                <Label htmlFor="config-default">{t("configuration.defaultCatalog")}</Label>
              </div>
            </div>

            <div>
              <div className="text-sm font-medium">{t("configuration.variants")}</div>
              {catalogConfig?.variants?.length ? (
                <div className="mt-2 space-y-2">
                  {catalogConfig.variants.map((variant) => (
                    <div
                      key={variant.id}
                      className="rounded-lg border px-3 py-2 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{variant.variant}</span>
                        {variant.isDefault && (
                          <Badge variant="secondary">{t("configuration.default")}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {variant.label || t("configuration.noLabel")}
                      </div>
                      <div className="text-xs font-mono text-muted-foreground">
                        {variant.listeningArchivedCatalogPath || t("configuration.noListeningPath")}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("configuration.noVariants")}
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
