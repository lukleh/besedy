"use client";

import { MapPin } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function LocationsPage() {
  return (
    <EnumCrudPage
      config={{
        entityName: "location",
        apiPath: "/api/metadata/locations",
        icon: MapPin,
        queryKey: ["metadata", "locations"],
      }}
    />
  );
}
