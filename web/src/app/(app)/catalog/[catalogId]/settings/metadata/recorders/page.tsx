"use client";

import { useParams } from "next/navigation";
import { Mic } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function RecordersPage() {
  const { catalogId } = useParams<{ catalogId: string }>();
  return (
    <EnumCrudPage
      catalogId={catalogId}
      config={{
        entityName: "recorder",
        resource: "recorders",
        icon: Mic,
        queryKey: ["metadata", "recorders"],
      }}
    />
  );
}
