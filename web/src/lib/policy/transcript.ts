import { canViewCatalogTranscripts, type CatalogPolicyContext } from "@/lib/policy/catalog";

export function canViewTranscript(context: CatalogPolicyContext): boolean {
  return canViewCatalogTranscripts(context);
}
