"use client";

import { useLocale, useTranslations } from "next-intl";
import { AlertCircle } from "lucide-react";
import { formatLocalDate } from "@/lib/date-format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatActionLabel } from "../utils";
import type {
  RelatedCatalogAccess,
  RelatedPendingCatalogGrant,
  RelatedPortalAdmission,
} from "./audit-detail-types";

export function getLifecycleBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "CLAIMED" || status === "CONSUMED" || status === "ACTIVE") {
    return "default";
  }
  if (status === "REVOKED" || status === "BLOCKED") {
    return "destructive";
  }
  if (status === "PENDING") {
    return "secondary";
  }
  return "outline";
}

export function CatalogAccessEntityCard({ access }: { access: RelatedCatalogAccess }) {
  const t = useTranslations("admin.audit.detail");
  const locale = useLocale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("relatedCatalogAccess")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{access.user.name || access.user.email}</p>
            {access.user.name && (
              <p className="text-sm text-muted-foreground">{access.user.email}</p>
            )}
          </div>
          <Badge variant={access.status === "ACTIVE" ? "default" : "destructive"}>
            {access.status}
          </Badge>
        </div>

        <Separator />

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("catalog")}</span>
            <span>{access.catalog.label || access.catalog.id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("accessLevel")}</span>
            <Badge variant="outline">{access.accessLevel}</Badge>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("granted")}</span>
            <span>{formatLocalDate(access.createdAt, locale, "MMM d, yyyy")}</span>
          </div>
          {access.revokedAt && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("revoked")}</span>
              <span>{formatLocalDate(access.revokedAt, locale, "MMM d, yyyy")}</span>
            </div>
          )}
        </div>

        {access.grantedBy && (
          <>
            <Separator />
            <div className="text-sm">
              <span className="text-muted-foreground">{t("grantedBy")}: </span>
              <span>{access.grantedBy.name || access.grantedBy.email}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PortalAdmissionEntityCard({
  admission,
}: {
  admission: RelatedPortalAdmission;
}) {
  const locale = useLocale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{formatActionLabel("portal_admission")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="font-medium">{admission.email}</span>
          <Badge variant={getLifecycleBadgeVariant(admission.status)}>{admission.status}</Badge>
        </div>

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Source</span>
            <span>{formatActionLabel(admission.source)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Admitted</span>
            <span>{formatLocalDate(admission.admittedAt, locale, "MMM d, yyyy")}</span>
          </div>
          {admission.claimedAt && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Claimed</span>
              <span>{formatLocalDate(admission.claimedAt, locale, "MMM d, yyyy")}</span>
            </div>
          )}
          {admission.revokedAt && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Revoked</span>
              <span>{formatLocalDate(admission.revokedAt, locale, "MMM d, yyyy")}</span>
            </div>
          )}
          {admission.revocationReason && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Reason</span>
              <span>{formatActionLabel(admission.revocationReason)}</span>
            </div>
          )}
          {admission.notes && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Notes</span>
              <span className="text-right">{admission.notes}</span>
            </div>
          )}
        </div>

        {(admission.admittedBy || admission.claimedBy || admission.revokedBy) && (
          <>
            <Separator />
            <div className="space-y-2 text-sm">
              {admission.admittedBy && (
                <div>
                  <span className="text-muted-foreground">Admitted by: </span>
                  <span>{admission.admittedBy.name || admission.admittedBy.email}</span>
                </div>
              )}
              {admission.claimedBy && (
                <div>
                  <span className="text-muted-foreground">Claimed by: </span>
                  <span>{admission.claimedBy.name || admission.claimedBy.email}</span>
                </div>
              )}
              {admission.revokedBy && (
                <div>
                  <span className="text-muted-foreground">Revoked by: </span>
                  <span>{admission.revokedBy.name || admission.revokedBy.email}</span>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function PendingCatalogGrantEntityCard({
  grant,
}: {
  grant: RelatedPendingCatalogGrant;
}) {
  const locale = useLocale();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{formatActionLabel("pending_catalog_grant")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium">{grant.email}</p>
            <p className="text-sm text-muted-foreground">{grant.catalog.label || grant.catalog.id}</p>
          </div>
          <Badge variant={getLifecycleBadgeVariant(grant.status)}>{grant.status}</Badge>
        </div>

        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Access level</span>
            <Badge variant="outline">{grant.accessLevel}</Badge>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Granted</span>
            <span>{formatLocalDate(grant.grantedAt, locale, "MMM d, yyyy")}</span>
          </div>
          {grant.consumedAt && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Consumed</span>
              <span>{formatLocalDate(grant.consumedAt, locale, "MMM d, yyyy")}</span>
            </div>
          )}
          {grant.revokedAt && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Revoked</span>
              <span>{formatLocalDate(grant.revokedAt, locale, "MMM d, yyyy")}</span>
            </div>
          )}
          {grant.notes && (
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Notes</span>
              <span className="text-right">{grant.notes}</span>
            </div>
          )}
        </div>

        {(grant.grantedBy || grant.consumedBy || grant.revokedBy) && (
          <>
            <Separator />
            <div className="space-y-2 text-sm">
              {grant.grantedBy && (
                <div>
                  <span className="text-muted-foreground">Granted by: </span>
                  <span>{grant.grantedBy.name || grant.grantedBy.email}</span>
                </div>
              )}
              {grant.consumedBy && (
                <div>
                  <span className="text-muted-foreground">Consumed by: </span>
                  <span>{grant.consumedBy.name || grant.consumedBy.email}</span>
                </div>
              )}
              {grant.revokedBy && (
                <div>
                  <span className="text-muted-foreground">Revoked by: </span>
                  <span>{grant.revokedBy.name || grant.revokedBy.email}</span>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function EntityNotFound({
  type,
  resourceId,
  error,
}: {
  type: string;
  resourceId: string | null;
  error?: string;
}) {
  const t = useTranslations("admin.audit.detail");

  return (
    <Card className="border-dashed">
      <CardContent className="py-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-muted-foreground">{error || t("entityNotFound", { type })}</p>
        {resourceId && (
          <p className="mt-2 font-mono text-xs text-muted-foreground">ID: {resourceId}</p>
        )}
      </CardContent>
    </Card>
  );
}
