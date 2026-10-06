"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Mic,
  MapPin,
  Disc,
  Menu,
  X,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { catalogLookupsPath } from "@/lib/catalog/lookup-paths";

function Sidebar({
  catalogId,
  className,
  onNavigate,
}: {
  catalogId: string;
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const t = useTranslations("enums");

  const navItems = [
    {
      title: t("recorders"),
      href: catalogLookupsPath(catalogId, "recorders"),
      icon: Mic,
    },
    {
      title: t("locations"),
      href: catalogLookupsPath(catalogId, "locations"),
      icon: MapPin,
    },
    {
      title: t("albums"),
      href: catalogLookupsPath(catalogId, "albums"),
      icon: Disc,
    },
  ];

  return (
    <nav className={cn("space-y-1", className)}>
      {navItems.map((item) => {
        const isActive = pathname.startsWith(item.href);

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
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}

function Breadcrumb({ catalogId }: { catalogId: string }) {
  const pathname = usePathname();
  const t = useTranslations("enums");
  const tSettings = useTranslations("catalogSettings");
  const current = pathname.split("/").filter(Boolean).at(-1);
  const titles: Record<string, string> = {
    recorders: t("recorders"),
    locations: t("locations"),
    albums: t("albums"),
  };
  const currentTitle = current ? titles[current] : undefined;

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      <Link href={`/catalog/${catalogId}/settings`} className="hover:text-foreground">
        {tSettings("titleDefault")}
      </Link>
      <ChevronRight className="h-4 w-4" />
      {currentTitle ? (
        <>
          <span>{tSettings("lookups.title")}</span>
          <ChevronRight className="h-4 w-4" />
          <span className="text-foreground font-medium">{currentTitle}</span>
        </>
      ) : (
        <span className="text-foreground font-medium">{tSettings("lookups.title")}</span>
      )}
    </nav>
  );
}

export default function MetadataLayoutClient({
  catalogId,
  children,
}: {
  catalogId: string;
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const tSettings = useTranslations("catalogSettings");

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
          <span className="font-semibold">{tSettings("lookups.title")}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="p-4">
          <h2 className="mb-4 hidden text-lg font-semibold lg:block">{tSettings("lookups.title")}</h2>
          <Sidebar catalogId={catalogId} onNavigate={() => setSidebarOpen(false)} />
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1">
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
          <Breadcrumb catalogId={catalogId} />
        </header>

        {/* Page content */}
        <div className="p-4 lg:p-6">{children}</div>
      </div>
    </div>
  );
}
