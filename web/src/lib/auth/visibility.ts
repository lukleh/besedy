import { getCatalogDiscoveryCapability } from "@/lib/access/capabilities";

/**
 * Compatibility adapter for legacy callers that still expect a bare list of
 * accessible workflow-group IDs.
 */
export async function getAccessibleWorkflowGroups(
  userId?: string
): Promise<string[]> {
  const capability = await getCatalogDiscoveryCapability(userId);
  return capability.accessibleCatalogIds;
}
