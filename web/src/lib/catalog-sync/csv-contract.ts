// Runtime copy of contracts/catalog-csv.json validation rules. The web image
// builds from web/ alone; catalog-csv-contract.test.ts checks this copy against
// the canonical file, whose rules are also checked against Python writers.
export const CATALOG_CSV_VALIDATION = {
  metadata: {
    requiredHeaders: ['Hash', 'Full Path'],
    nonBlankCells: ['Hash', 'Full Path'],
  },
  archived: {
    requiredHeaders: ['Hash', 'Original Path', 'Compressed Path'],
    nonBlankCells: ['Hash', 'Original Path', 'Compressed Path'],
  },
  duplicates: {
    requiredHeaders: ['Hash', 'Original Path', 'Duplicate Path'],
    nonBlankCells: ['Hash', 'Duplicate Path'],
  },
} as const;
