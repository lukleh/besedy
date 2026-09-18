import { getLocale, getTranslations } from "next-intl/server";
import { WebUpdateEventType } from "@/generated/prisma/enums";
import prisma from "@/lib/db";
import { requireAdminPageAccess } from "@/lib/access/require-admin-page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

function countFor(
  counts: { event: WebUpdateEventType; _count: { _all: number } }[],
  event: WebUpdateEventType
): number {
  return counts.find((item) => item.event === event)?._count._all ?? 0;
}

export default async function WebUpdatesPage() {
  await requireAdminPageAccess();
  const t = await getTranslations("admin.webUpdates");
  const locale = await getLocale();
  // This is a dynamic server page; the query window intentionally starts at request time.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [counts, recent] = await Promise.all([
    prisma.webUpdateEvent.groupBy({
      by: ["event"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.webUpdateEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { name: true, email: true } } },
    }),
  ]);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
  });
  const metrics = [
    [t("metrics.seen"), countFor(counts, WebUpdateEventType.CLIENT_SEEN)],
    [t("metrics.detected"), countFor(counts, WebUpdateEventType.UPDATE_DETECTED)],
    [t("metrics.completed"), countFor(counts, WebUpdateEventType.ACTIVATION_COMPLETE)],
    [t("metrics.delayed"), countFor(counts, WebUpdateEventType.ACTIVATION_DELAYED)],
    [t("metrics.blocked"), countFor(counts, WebUpdateEventType.APPLY_BLOCKED)],
    [t("metrics.probeFailed"), countFor(counts, WebUpdateEventType.VERSION_PROBE_FAILED)],
  ] as const;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {metrics.map(([label, value]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{value}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("recentTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.time")}</TableHead>
                <TableHead>{t("table.event")}</TableHead>
                <TableHead>{t("table.version")}</TableHead>
                <TableHead>{t("table.user")}</TableHead>
                <TableHead>{t("table.context")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap">
                    {dateFormatter.format(item.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`events.${item.event.toLowerCase()}`)}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {item.clientVersion ?? "?"} → {item.targetVersion ?? "?"}
                  </TableCell>
                  <TableCell>{item.user?.name ?? item.user?.email ?? t("anonymous")}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[item.routeGroup, item.browser, ...item.blockerKinds].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
              {recent.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
