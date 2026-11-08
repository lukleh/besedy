import { useArchive } from "@/hooks/use-archive";
import { isFinalClientError } from "@/lib/api/fetch-json";

interface UseCatalogContextOptions {
  skipCatalogValidation?: boolean;
}

export function useCatalogContext(
  catalogId: string,
  options?: UseCatalogContextOptions
) {
  const query = useArchive({ enabled: !!catalogId });
  const catalogNotFound = !!catalogId && (
    (query.data !== undefined && query.data.id !== catalogId) ||
    isFinalClientError(query.error)
  );
  return {
    ...query,
    catalogId,
    archive: query.data ?? null,
    catalogNotFound,
    catalogValidationLoading:
      !!catalogId && !options?.skipCatalogValidation && query.isLoading,
  };
}
