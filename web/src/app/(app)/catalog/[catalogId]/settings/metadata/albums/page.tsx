"use client";

import { useParams } from "next/navigation";
import { Disc } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function AlbumsPage() {
  const { catalogId } = useParams<{ catalogId: string }>();
  return (
    <EnumCrudPage
      catalogId={catalogId}
      config={{
        entityName: "album",
        resource: "albums",
        icon: Disc,
        queryKey: ["metadata", "albums"],
      }}
    />
  );
}
