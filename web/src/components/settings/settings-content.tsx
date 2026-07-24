"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { ArrowLeft, Plus, Check, FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCatalogs } from "@/hooks/use-catalogs";
import { fetchJson } from "@/lib/api/fetch-json";

interface DiscoveredGroup {
  id: string;
  label: string;
  archivedCatalogPath: string;
  metadataCatalogPath: string;
  transcriptsPath?: string;
}

interface DiscoverResponse {
  baseDir: string;
  discovered: number;
  new: number;
  groups: DiscoveredGroup[];
}

export function SettingsContent() {
  const t = useTranslations("settings");
  const queryClient = useQueryClient();
  const router = useRouter();

  // Fetch existing catalogs
  const { data: groups, isLoading: loadingGroups } = useCatalogs();

  // Discover new catalogs
  const {
    data: discovered,
    isLoading: loadingDiscovered,
    refetch: refetchDiscovered,
  } = useQuery<DiscoverResponse>({
    queryKey: ["catalogs-discover"],
    queryFn: () => fetchJson<DiscoverResponse>("/api/catalogs/discover"),
  });

  // Add catalog mutation
  const addGroup = useMutation({
    mutationFn: async (group: DiscoveredGroup) => {
      return fetchJson("/api/catalogs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(group),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalogs"] });
      queryClient.invalidateQueries({ queryKey: ["catalogs-discover"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
    },
  });

  return (
    <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" />
        {t("backToCatalog")}
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">
          {t("description")}
        </p>
      </div>

      <div className="space-y-6">
        {/* Registered Groups */}
        <Card>
          <CardHeader>
            <CardTitle>{t("workflowGroups")}</CardTitle>
            <CardDescription>
              {t("workflowGroupsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loadingGroups ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : groups && groups.length > 0 ? (
              <div className="space-y-2">
                {groups.map((group) => {
                  const canNavigate = true;

                  return (
                    <div
                      key={group.id}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        canNavigate ? "cursor-pointer transition hover:bg-muted/50" : ""
                      }`}
                      role={canNavigate ? "button" : undefined}
                      tabIndex={canNavigate ? 0 : undefined}
                      onClick={() => {
                        if (canNavigate) {
                          router.push(`/catalog/${group.id}/settings`);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (!canNavigate) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          router.push(`/catalog/${group.id}/settings`);
                        }
                      }}
                    >
                    <div className="min-w-0">
                      <div className="font-medium flex items-center gap-2">
                        {group.label || group.id}
                        {group.isDefault && (
                          <Badge variant="secondary">{t("default")}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {group.id}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        {group.transcriptsPath ? t("hasTranscripts") : t("noTranscripts")}
                      </Badge>
                    </div>
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <p>{t("noGroups")}</p>
                <p className="text-sm mt-1">
                  {t("noGroupsDescription")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Discover Groups */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FolderSearch className="h-5 w-5" />
              {t("discoverGroups")}
            </CardTitle>
            <CardDescription>
              {t("discoverDescription")}
              {discovered?.baseDir && (
                <span className="block mt-1 font-mono text-xs">
                  Base: {discovered.baseDir}
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              onClick={() => refetchDiscovered()}
              disabled={loadingDiscovered}
              className="mb-4"
            >
              {loadingDiscovered ? t("scanning") : t("scanGroups")}
            </Button>

            {loadingDiscovered ? (
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : discovered && discovered.groups.length > 0 ? (
              <div className="space-y-2">
                {discovered.groups.map((group) => (
                  <div
                    key={group.id}
                    className="flex items-center justify-between p-3 rounded-lg border bg-muted/50"
                  >
                    <div>
                      <div className="font-medium">{group.label}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {group.id}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => addGroup.mutate(group)}
                      disabled={addGroup.isPending}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      {t("add")}
                    </Button>
                  </div>
                ))}
              </div>
            ) : discovered ? (
              <div className="text-center py-4 text-muted-foreground">
                <Check className="h-8 w-8 mx-auto mb-2 text-green-500" />
                <p>{t("allRegistered")}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Manual Entry */}
        <Card>
          <CardHeader>
            <CardTitle>{t("manualEntry")}</CardTitle>
            <CardDescription>
              {t("manualEntryDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ManualGroupForm
              onSubmit={(group) => addGroup.mutate(group)}
              disabled={addGroup.isPending}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface ManualGroupFormProps {
  onSubmit: (group: DiscoveredGroup) => void;
  disabled?: boolean;
}

function ManualGroupForm({ onSubmit, disabled }: ManualGroupFormProps) {
  const t = useTranslations("settings");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [archivedPath, setArchivedPath] = useState("");
  const [metadataPath, setMetadataPath] = useState("");
  const [transcriptsPath, setTranscriptsPath] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !archivedPath || !metadataPath) return;

    onSubmit({
      id,
      label: label || id,
      archivedCatalogPath: archivedPath,
      metadataCatalogPath: metadataPath,
      transcriptsPath: transcriptsPath || undefined,
    });

    // Reset form
    setId("");
    setLabel("");
    setArchivedPath("");
    setMetadataPath("");
    setTranscriptsPath("");
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label htmlFor="id" className="text-sm font-medium">
            {t("groupId")} *
          </label>
          <Input
            id="id"
            placeholder="20251201_143022"
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="label" className="text-sm font-medium">
            {t("groupLabel")}
          </label>
          <Input
            id="label"
            placeholder="My Workflow Group"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="archived" className="text-sm font-medium">
          {t("archivedPath")} *
        </label>
        <Input
          id="archived"
          placeholder="/path/to/audio_catalog_20251201_143022_loudness_archived.csv"
          value={archivedPath}
          onChange={(e) => setArchivedPath(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="metadata" className="text-sm font-medium">
          {t("metadataPath")} *
        </label>
        <Input
          id="metadata"
          placeholder="/path/to/audio_catalog_20251201_143022.csv"
          value={metadataPath}
          onChange={(e) => setMetadataPath(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <label htmlFor="transcripts" className="text-sm font-medium">
          {t("transcriptsPath")}
        </label>
        <Input
          id="transcripts"
          placeholder="/path/to/transcripts_20251201_143022/"
          value={transcriptsPath}
          onChange={(e) => setTranscriptsPath(e.target.value)}
        />
      </div>

      <Button type="submit" disabled={disabled || !id || !archivedPath || !metadataPath}>
        <Plus className="h-4 w-4 mr-1" />
        {t("addGroup")}
      </Button>
    </form>
  );
}
