"use client";

import { Mic } from "lucide-react";
import { EnumCrudPage } from "@/components/settings/enum-crud-page";

export default function RecordersPage() {
  return (
    <EnumCrudPage
      config={{
        entityName: "recorder",
        apiPath: "/api/metadata/recorders",
        icon: Mic,
        queryKey: ["metadata", "recorders"],
      }}
    />
  );
}
