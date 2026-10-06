"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Disc, MapPin, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { catalogLookupsPath } from "@/lib/catalog/lookup-paths";

interface CatalogSettingsLookupsCardProps {
  catalogId: string;
}

/** Links to the catalog's lookup lists, for those who may manage them. */
export function CatalogSettingsLookupsCard({ catalogId }: CatalogSettingsLookupsCardProps) {
  const t = useTranslations("catalogSettings.lookups");
  const tEnums = useTranslations("enums");

  const links = [
    { resource: "recorders", label: tEnums("recorders"), icon: Mic },
    { resource: "locations", label: tEnums("locations"), icon: MapPin },
    { resource: "albums", label: tEnums("albums"), icon: Disc },
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {links.map(({ resource, label, icon: Icon }) => (
          <Button key={resource} variant="outline" asChild>
            <Link href={catalogLookupsPath(catalogId, resource)}>
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
