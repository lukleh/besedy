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

function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const t = useTranslations("enums");

  const navItems = [
    {
      title: t("recorders"),
      href: "/admin/metadata/recorders",
      icon: Mic,
    },
    {
      title: t("locations"),
      href: "/admin/metadata/locations",
      icon: MapPin,
    },
    {
      title: t("albums"),
      href: "/admin/metadata/albums",
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

function Breadcrumb() {
  const pathname = usePathname();
  const t = useTranslations("enums");
  const segments = pathname.split("/").filter(Boolean);

  const titles: Record<string, string> = {
    admin: "Admin",
    metadata: t("title"),
    recorders: t("recorders"),
    locations: t("locations"),
    albums: t("albums"),
  };

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground">
      {segments.map((segment, index) => {
        const href = "/" + segments.slice(0, index + 1).join("/");
        const isLast = index === segments.length - 1;
        const title = titles[segment] || segment.charAt(0).toUpperCase() + segment.slice(1);

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

export default function MetadataLayoutClient({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const t = useTranslations("enums");

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
        <div className="p-4">
          <h2 className="mb-4 hidden text-lg font-semibold lg:block">{t("title")}</h2>
          <Sidebar onNavigate={() => setSidebarOpen(false)} />
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
          <Breadcrumb />
        </header>

        {/* Page content */}
        <div className="p-4 lg:p-6">{children}</div>
      </div>
    </div>
  );
}
