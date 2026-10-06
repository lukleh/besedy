import { redirect } from "next/navigation";
import { catalogLookupsPath } from "@/lib/catalog/lookup-paths";

interface MetadataPageProps {
  params: Promise<{ catalogId: string }>;
}

export default async function MetadataPage({ params }: MetadataPageProps) {
  const { catalogId } = await params;
  redirect(catalogLookupsPath(catalogId, "recorders"));
}
