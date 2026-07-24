"use client";

export interface ResolveEffectiveCatalogIdOptions {
  routeGroupId: string | null;
  activeGroupId: string | null;
  validGroupIds?: string[] | null;
}

export interface EffectiveCatalogIdResult {
  effectiveCatalogId: string | null;
  routeGroupInvalid: boolean;
}

export function resolveEffectiveCatalogId({
  routeGroupId,
  activeGroupId,
  validGroupIds,
}: ResolveEffectiveCatalogIdOptions): EffectiveCatalogIdResult {
  const routeGroupInvalid =
    !!routeGroupId &&
    Array.isArray(validGroupIds) &&
    !validGroupIds.includes(routeGroupId);

  return {
    effectiveCatalogId: routeGroupInvalid
      ? null
      : routeGroupId ?? activeGroupId ?? null,
    routeGroupInvalid,
  };
}

export function useEffectiveCatalogId(
  options: ResolveEffectiveCatalogIdOptions
): EffectiveCatalogIdResult {
  return resolveEffectiveCatalogId(options);
}
