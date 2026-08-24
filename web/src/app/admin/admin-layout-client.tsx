"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Users,
  LayoutDashboard,
  Menu,
  X,
  ChevronRight,
  ScrollText,
  GitCommit,
  AlertTriangle,
  FolderCog,
  ListPlus,
  ListOrdered,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api/fetch-json";
import { SESSION_STATIC_QUERY_PROFILE } from "@/lib/query/profiles";

interface VersionInfo {
  commit: string;
  commitShort: string;
  webVersion: string;
  buildTime: string | null;
  environment: string;
}

const navItems = [
  {
    titleKey: "nav.dashboard" as const,
    href: "/admin",
    icon: LayoutDashboard,
  },
  {
    titleKey: "nav.users" as const,
    href: "/admin/users",
    icon: Users,
  },
  {
    titleKey: "nav.catalogs" as const,
    href: "/admin/catalogs",
    icon: FolderCog,
  },
  {
    titleKey: "nav.metadata" as const,
    href: "/admin/metadata",
    icon: ListPlus,
  },
  {
    titleKey: "nav.transcripts" as const,
    href: "/admin/transcript-order",
    icon: ListOrdered,
  },
  {
    titleKey: "nav.auditLog" as const,
    href: "/admin/audit",
    icon: ScrollText,
  },
  {
    titleKey: "nav.clientErrors" as const,
    href: "/admin/client-errors",
    icon: AlertTriangle,
  },
  {
    titleKey: "nav.webUpdates" as const,
    href: "/admin/web-updates",
    icon: RefreshCw,
  },
];

function VersionDisplay() {
  const { data: version } = useQuery<VersionInfo>({
    queryKey: ["version"],
    queryFn: () => fetchJson<VersionInfo>("/api/version"),
    ...SESSION_STATIC_QUERY_PROFILE,
    retry: false,
  });

  if (!version || version.commit === "unknown") {
    return null;
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <GitCommit className="h-3 w-3" />
      <span
        className="font-mono"
        title={`Commit: ${version.commit}\nWeb: ${version.webVersion}\n${version.buildTime ? `Built: ${version.buildTime}` : ""}`}
      >
        {version.commitShort}
      </span>
    </div>
  );
}

function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const t = useTranslations("admin");

  return (
    <nav className={cn("space-y-1", className)}>
      {navItems.map((item) => {
        const isActive =
          item.href === "/admin"
            ? pathname === "/admin"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <item.icon className="h-4 w-4" />
            {t(item.titleKey)}
          </Link>
        );
      })}
    </nav>
  );
}

function Breadcrumb() {
  const pathname = usePathname();
  const t = useTranslations("admin");
  const segments = pathname.split("/").filter(Boolean);

  const getTitle = (segment: string): string => {
    // Map path segments to translation keys
    const segmentMap: Record<string, string> = {
      admin: t("title"),
      users: t("nav.users"),
      catalogs: t("nav.catalogs"),
      metadata: t("nav.metadata"),
      "transcript-order": t("nav.transcripts"),
      audit: t("nav.auditLog"),
      "client-errors": t("nav.clientErrors"),
    };
    return segmentMap[segment] ?? segment.charAt(0).toUpperCase() + segment.slice(1);
  };

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      {segments.map((segment, index) => {
        const href = "/" + segments.slice(0, index + 1).join("/");
        const isLast = index === segments.length - 1;
        const title = getTitle(segment);

        return (
          <span key={href} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="h-4 w-4" />}
            {isLast ? (
              <span className="text-foreground font-medium">{title}</span>
            ) : (
              <Link href={href} className="hover:text-foreground">
                {title}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default function AdminLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const t = useTranslations("admin");

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)]">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 transform border-r bg-background transition-transform duration-200 ease-in-out lg:static lg:z-auto lg:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4 lg:hidden">
          <span className="font-semibold">{t("title")}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex flex-col h-[calc(100%-3.5rem)] lg:h-full">
          <div className="flex-1 p-4">
            <h2 className="mb-4 hidden text-lg font-semibold lg:block">{t("title")}</h2>
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </div>
          <div className="p-4 border-t">
            <VersionDisplay />
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Mobile header */}
        <header className="flex h-14 items-center gap-4 border-b px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Breadcrumb />
        </header>

        {/* Page content */}
        <div className="p-4 lg:p-6">{children}</div>
      </div>
    </div>
  );
}
