import { redirect } from "next/navigation";
import { getAdminCapability } from "@/lib/access/capabilities";
import MetadataLayoutClient from "./metadata-layout-client";

export default async function MetadataLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const capability = await getAdminCapability();

  if (!capability.hasEditorOnAnyCatalog) {
    redirect("/");
  }

  // Providers already wrapped at root layout level
  return <MetadataLayoutClient>{children}</MetadataLayoutClient>;
}
