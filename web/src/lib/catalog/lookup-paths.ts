/** The lookup lists one catalog's metadata picks from. */
export type CatalogLookupResource = "recorders" | "locations" | "albums";

/** Page of one lookup list in the catalog settings. */
export function catalogLookupsPath(catalogId: string, resource: CatalogLookupResource): string {
  return `/catalog/${catalogId}/settings/metadata/${resource}`;
}

/** API collection of one lookup list. */
export function catalogLookupsApiPath(catalogId: string, resource: CatalogLookupResource): string {
  return `/api/catalogs/${catalogId}/metadata/${resource}`;
}
