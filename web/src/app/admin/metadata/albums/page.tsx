"use client";

import { Disc } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function AlbumsPage() {
  return (
    <EnumCrudPage
      config={{
        entityName: "album",
        apiPath: "/api/metadata/albums",
        icon: Disc,
        queryKey: ["metadata", "albums"],
      }}
    />
  );
}
