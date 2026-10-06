"use client";

import { useParams } from "next/navigation";
import { MapPin } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function LocationsPage() {
  const { catalogId } = useParams<{ catalogId: string }>();
  return (
    <EnumCrudPage
      catalogId={catalogId}
      config={{
        entityName: "location",
        resource: "locations",
        icon: MapPin,
        queryKey: ["metadata", "locations"],
      }}
    />
  );
}
