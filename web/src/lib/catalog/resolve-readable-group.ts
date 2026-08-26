export type ReadableGroupResolutionSource =
  'explicit' | 'preference' | 'default' | 'recent';

export function selectDefaultReadableGroup<
  T extends { id: string; isDefault: boolean },
>(
  groups: T[],
  preferredGroupId: string | null | undefined,
): {
  group: T;
  source: Exclude<ReadableGroupResolutionSource, 'explicit'>;
} | null {
  if (preferredGroupId) {
    const preferredGroup = groups.find(
      (group) => group.id === preferredGroupId,
    );
    if (preferredGroup) {
      return { group: preferredGroup, source: 'preference' };
    }
  }

  const defaultGroup = groups.find((group) => group.isDefault);
  if (defaultGroup) {
    return { group: defaultGroup, source: 'default' };
  }

  const recentGroup = groups[0];
  return recentGroup ? { group: recentGroup, source: 'recent' } : null;
}
