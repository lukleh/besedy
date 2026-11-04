/** Server page search params, as Next.js passes them to a page component. */
export type PageSearchParams = Record<string, string | string[] | undefined>;

/** The first value of a query parameter that may be repeated. */
export function getFirstSearchParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
