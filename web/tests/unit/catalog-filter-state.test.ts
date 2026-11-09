import { describe, expect, it } from "vitest";
import {
  buildCatalogFilterParams,
  restoreCatalogFilters,
} from "@/components/catalog/catalog-list/filter-state";
import { buildCatalogParams } from "@/components/catalog/catalog-list/utils/build-catalog-params";

describe("catalog request filters", () => {
  it("keeps facet and list criteria identical when persisted dates lack their parent", () => {
    const filters = restoreCatalogFilters({
      dateMonth: "3",
      dateDay: "12",
      verified: "unverified",
      recorder: "empty",
    });
    const facets = buildCatalogFilterParams(filters);
    const list = buildCatalogParams(filters, 2, 50);
    list.delete("page");
    list.delete("limit");
    expect(Object.fromEntries(list)).toEqual(Object.fromEntries(facets));
    expect(Object.fromEntries(facets)).toEqual({
      verified: "false",
      recorder: "empty",
    });
  });

  it("ignores invalid saved enum values while restoring valid sort and metadata choices", () => {
    const filters = restoreCatalogFilters({
      status: "invalid",
      duration: "invalid",
      verified: "invalid",
      sortKey: "location",
      sortDir: "asc",
      location: "7",
      page: 3,
    });
    expect(buildCatalogParams(filters, filters.page, 50).toString()).toBe(
      "page=3&limit=50&location=7&sort=location&dir=asc",
    );
  });
});
