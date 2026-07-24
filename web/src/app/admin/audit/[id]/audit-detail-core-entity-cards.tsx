"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
  Calendar,
  CheckCircle,
  Clock,
  FileAudio,
  FolderOpen,
  Hash,
  MapPin,
  Mic,
  Music,
  Tag,
  User,
} from "lucide-react";
import { formatLocalDate } from "@/lib/date-format";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CopyableHash, getInitials } from "./audit-detail-shared-sections";
import type {
  RelatedAudio,
  RelatedCatalog,
  RelatedUser,
} from "./audit-detail-types";

export function UserEntityCard({ user }: { user: RelatedUser }) {
  const t = useTranslations("admin");
  const locale = useLocale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <User className="h-4 w-4" />
          {t("audit.detail.relatedUser")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={user.image || undefined} />
            <AvatarFallback>{getInitials(user.name, user.email)}</AvatarFallback>
          </Avatar>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{user.name || user.email}</span>
              {user.isSuperadmin && (
                <Badge className="bg-purple-600 text-xs">Superadmin</Badge>
              )}
              {user.isAdmin && !user.isSuperadmin && (
                <Badge variant="secondary" className="text-xs">
                  Admin
                </Badge>
              )}
            </div>
            {user.name && <p className="text-sm text-muted-foreground">{user.email}</p>}
          </div>
          <Badge
            variant={
              user.status === "ACTIVE"
                ? "default"
                : user.status === "BLOCKED"
                  ? "destructive"
                  : "secondary"
            }
          >
            {user.status}
          </Badge>
        </div>

        <Separator />

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("userDetail.memberSince")}</span>
            <span>{formatLocalDate(user.createdAt, locale, "MMM d, yyyy")}</span>
          </div>
          {user.lastLoginAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("userDetail.lastLogin")}</span>
              <span>{formatLocalDate(user.lastLoginAt, locale, "MMM d, yyyy HH:mm")}</span>
            </div>
          )}
        </div>

        {user.catalogAccess && user.catalogAccess.length > 0 && (
          <>
            <Separator />
            <div>
              <p className="mb-2 text-sm font-medium">{t("userDetail.catalogAccess")}</p>
              <div className="space-y-1">
                {user.catalogAccess.map((access) => (
                  <div key={access.id} className="flex justify-between text-sm">
                    <span>{access.catalog.label || access.catalogId}</span>
                    <Badge variant="outline" className="text-xs">
                      {access.accessLevel}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <Link
          href={`/admin/users/${user.id}`}
          className="block text-sm text-primary hover:underline"
        >
          {t("audit.detail.viewUser")} →
        </Link>
      </CardContent>
    </Card>
  );
}

export function AudioEntityCard({ audio }: { audio: RelatedAudio }) {
  const t = useTranslations("admin.audit.detail");

  const formatDate = () => {
    const { dateYear, dateMonth, dateDay } = audio.sourceMetadata || {};
    if (!dateYear) return null;
    const parts: string[] = [String(dateYear)];
    if (dateMonth) parts.push(String(dateMonth).padStart(2, "0"));
    if (dateDay) parts.push(String(dateDay).padStart(2, "0"));
    return parts.join("-");
  };

  const getDisplayTitle = () => {
    if (audio.sourceMetadata?.title) return audio.sourceMetadata.title;
    if (audio.entry.source_path) {
      const parts = audio.entry.source_path.split("/");
      return parts[parts.length - 1] || `${audio.hash.slice(0, 16)}...`;
    }
    return `${audio.hash.slice(0, 16)}...`;
  };

  const formattedDate = formatDate();
  const meta = audio.sourceMetadata;
  const displayTitle = getDisplayTitle();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileAudio className="h-4 w-4" />
          {t("relatedAudio")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <h3 className="text-xl font-semibold">{displayTitle}</h3>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {meta?.artist && (
              <div className="flex items-center gap-1">
                <Music className="h-3 w-3" />
                {meta.artist}
              </div>
            )}
            {meta?.album && <div className="text-muted-foreground/70">{meta.album}</div>}
            {formattedDate && (
              <div className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {formattedDate}
              </div>
            )}
            {meta?.location && (
              <div className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {meta.location}
              </div>
            )}
            {meta?.recorder && (
              <div className="flex items-center gap-1">
                <Mic className="h-3 w-3" />
                {meta.recorder}
              </div>
            )}
            {audio.entry.duration_hms && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {audio.entry.duration_hms}
              </div>
            )}
          </div>

          {audio.entry.source_path && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate" title={audio.entry.source_path}>
                {audio.entry.source_path}
              </span>
            </div>
          )}

          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Hash className="h-3 w-3 shrink-0" />
            <CopyableHash hash={audio.hash} />
          </div>
        </div>

        <Separator />

        <div className="grid gap-2 text-sm">
          {audio.entry.file_size_mb > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("fileSize")}</span>
              <span>{audio.entry.file_size_mb.toFixed(1)} MB</span>
            </div>
          )}
          {audio.entry.extension && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("format")}</span>
              <span>{audio.entry.extension.toUpperCase()}</span>
            </div>
          )}
          {meta?.verified !== undefined && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("verified")}</span>
              {meta.verified ? (
                <div className="flex items-center gap-1 text-green-600">
                  <CheckCircle className="h-4 w-4" />
                  {t("yes")}
                </div>
              ) : (
                <span className="text-muted-foreground">{t("no")}</span>
              )}
            </div>
          )}
          {audio.workflowGroup && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("catalog")}</span>
              <span>{audio.workflowGroup.label || audio.workflowGroup.id}</span>
            </div>
          )}
        </div>

        {meta?.tags && meta.tags.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="mb-2 flex items-center gap-1 text-sm text-muted-foreground">
                <Tag className="h-3 w-3" />
                {t("tags")}
              </div>
              <div className="flex flex-wrap gap-1">
                {meta.tags.map((tag, index) => (
                  <Badge key={index} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </>
        )}

        {meta?.notes && (
          <>
            <Separator />
            <div>
              <p className="mb-1 text-sm text-muted-foreground">{t("notes")}</p>
              <p className="text-sm">{meta.notes}</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function CatalogEntityCard({ catalog }: { catalog: RelatedCatalog }) {
  const t = useTranslations("admin.audit.detail");
  const locale = useLocale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("relatedCatalog")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="font-medium">{catalog.label || catalog.id}</span>
          <div className="flex gap-2">
            {catalog.isDefault && <Badge variant="default">{t("default")}</Badge>}
            <Badge variant={catalog.isActive ? "default" : "secondary"}>
              {catalog.isActive ? t("active") : t("inactive")}
            </Badge>
          </div>
        </div>

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("catalogId")}</span>
            <span className="font-mono text-xs">{catalog.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("created")}</span>
            <span>{formatLocalDate(catalog.createdAt, locale, "MMM d, yyyy")}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
