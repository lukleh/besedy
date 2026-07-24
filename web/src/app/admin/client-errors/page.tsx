"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Filter,
  X,
  Eye,
} from "lucide-react";
import { fetchJson } from "@/lib/api/fetch-json";

interface ClientErrorReport {
  id: string;
  message: string;
  stack: string | null;
  digest: string | null;
  source: string | null;
  url: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  context: unknown;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
}

interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const SOURCE_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "error-boundary": "default",
  "window.onerror": "secondary",
  "window.unhandledrejection": "outline",
};

function formatUserAgent(ua: string | null): string {
  if (!ua) return "-";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari")) return "Safari";
  if (ua.includes("Edge")) return "Edge";
  return ua.slice(0, 30) + "...";
}

function formatUrl(value: string | null): string {
  if (!value) return "-";
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.length > 1 ? parsed.pathname : "";
    return `${parsed.hostname}${path}`.slice(0, 40);
  } catch {
    return value.length > 40 ? `${value.slice(0, 40)}...` : value;
  }
}

function formatMessage(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}...` : value;
}

export default function ClientErrorsPage() {
  const t = useTranslations("admin.clientErrors");
  const [reports, setReports] = useState<ClientErrorReport[]>([]);
  const [pagination, setPagination] = useState<PaginationInfo>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState<ClientErrorReport | null>(null);

  // Filters
  const [sourceFilter, setSourceFilter] = useState("");
  const [messageFilter, setMessageFilter] = useState("");
  const [digestFilter, setDigestFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("page", String(pagination.page));
      params.set("limit", String(pagination.limit));
      if (sourceFilter) params.set("source", sourceFilter);
      if (messageFilter) params.set("message", messageFilter);
      if (digestFilter) params.set("digest", digestFilter);
      if (dateFrom) params.set("from", dateFrom);
      if (dateTo) params.set("to", dateTo);

      const data = await fetchJson<{
        reports: ClientErrorReport[];
        pagination: PaginationInfo;
      }>(`/api/admin/client-errors?${params.toString()}`);
      setReports(data.reports);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.limit, sourceFilter, messageFilter, digestFilter, dateFrom, dateTo]);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const clearFilters = () => {
    setSourceFilter("");
    setMessageFilter("");
    setDigestFilter("");
    setDateFrom("");
    setDateTo("");
    setPagination((p) => ({ ...p, page: 1 }));
  };

  const hasFilters = sourceFilter || messageFilter || digestFilter || dateFrom || dateTo;

  const dialogContext = selectedReport?.context
    ? JSON.stringify(selectedReport.context, null, 2)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <Button variant="outline" onClick={fetchReports} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 items-end p-4 border rounded-lg bg-muted/30">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t("filters.label")}</span>
        </div>

        <div className="flex-1 min-w-[160px] max-w-[220px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            {t("filters.source")}
          </label>
          <Input
            placeholder={t("filters.sourcePlaceholder")}
            value={sourceFilter}
            onChange={(e) => {
              setSourceFilter(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>

        <div className="flex-1 min-w-[180px] max-w-[260px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            {t("filters.message")}
          </label>
          <Input
            placeholder={t("filters.messagePlaceholder")}
            value={messageFilter}
            onChange={(e) => {
              setMessageFilter(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>

        <div className="flex-1 min-w-[160px] max-w-[220px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            {t("filters.digest")}
          </label>
          <Input
            placeholder={t("filters.digestPlaceholder")}
            value={digestFilter}
            onChange={(e) => {
              setDigestFilter(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>

        <div className="flex-1 min-w-[150px] max-w-[180px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            {t("filters.from")}
          </label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>

        <div className="flex-1 min-w-[150px] max-w-[180px]">
          <label className="text-xs text-muted-foreground mb-1 block">
            {t("filters.to")}
          </label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setPagination((p) => ({ ...p, page: 1 }));
            }}
          />
        </div>

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="h-4 w-4 mr-1" />
            {t("filters.clear")}
          </Button>
        )}
      </div>

      {error && (
        <div className="p-4 bg-destructive/10 text-destructive rounded-lg">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">{t("table.timestamp")} (UTC)</TableHead>
              <TableHead>{t("table.message")}</TableHead>
              <TableHead className="hidden md:table-cell landscape-mobile:hidden">
                {t("table.source")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">{t("table.url")}</TableHead>
              <TableHead className="hidden md:table-cell landscape-mobile:hidden">
                {t("table.user")}
              </TableHead>
              <TableHead className="hidden lg:table-cell">{t("table.ip")}</TableHead>
              <TableHead className="hidden lg:table-cell">{t("table.browser")}</TableHead>
              <TableHead className="w-[90px]">{t("table.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8">
                  {t("loading")}
                </TableCell>
              </TableRow>
            ) : reports.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  {t("noLogs")}
                </TableCell>
              </TableRow>
            ) : (
              reports.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-mono text-xs">
                    {new Date(report.createdAt).toISOString().replace("T", " ").slice(0, 19)}
                  </TableCell>
                  <TableCell title={report.message}>{formatMessage(report.message)}</TableCell>
                  <TableCell className="hidden md:table-cell landscape-mobile:hidden">
                    <Badge variant={SOURCE_VARIANTS[report.source ?? ""] ?? "outline"}>
                      {report.source || "-"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">
                    {formatUrl(report.url)}
                  </TableCell>
                  <TableCell className="hidden md:table-cell landscape-mobile:hidden">
                    {report.user ? (
                      <span title={report.user.email || undefined}>
                        {report.user.name || report.user.email || report.user.id}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("system")}</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">
                    {report.ipAddress || "-"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs">
                    {formatUserAgent(report.userAgent)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedReport(report)}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      {t("view")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {t("pagination.showing", { count: reports.length, total: pagination.total })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page <= 1}
            onClick={() => setPagination((p) => ({ ...p, page: p.page - 1 }))}
          >
            <ChevronLeft className="h-4 w-4" />
            {t("pagination.previous")}
          </Button>
          <span className="text-sm">
            {t("pagination.page", { page: pagination.page, totalPages: pagination.totalPages })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => setPagination((p) => ({ ...p, page: p.page + 1 }))}
          >
            {t("pagination.next")}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog
        open={!!selectedReport}
        onOpenChange={(open) => {
          if (!open) setSelectedReport(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("details.title")}</DialogTitle>
            <DialogDescription>{selectedReport?.message}</DialogDescription>
          </DialogHeader>
          {selectedReport && (
            <div className="space-y-4 text-sm">
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.source")}</div>
                <div>{selectedReport.source || "-"}</div>
              </div>
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.url")}</div>
                <div className="break-all">{selectedReport.url || "-"}</div>
              </div>
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.digest")}</div>
                <div>{selectedReport.digest || "-"}</div>
              </div>
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.user")}</div>
                <div>
                  {selectedReport.user
                    ? selectedReport.user.name || selectedReport.user.email || selectedReport.user.id
                    : t("system")}
                </div>
              </div>
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.stack")}</div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                  {selectedReport.stack || "-"}
                </pre>
              </div>
              <div className="grid gap-2">
                <div className="text-muted-foreground">{t("details.context")}</div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                  {dialogContext || "-"}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
