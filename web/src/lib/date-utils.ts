/**
 * Client-safe date utilities.
 * These functions can be imported in client components without pulling in Node.js modules.
 */

/**
 * Parse various date string formats into year/month/day components.
 * Supports ISO, DMY, and year-only formats.
 */
export function parseDateFromString(date?: string | null): {
  year?: number;
  month?: number;
  day?: number;
} | null {
  if (!date) return null;
  const cleaned = date.trim();

  // ISO format: YYYY-MM-DD or YYYY/MM/DD
  const iso = cleaned.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (iso) {
    return {
      year: parseInt(iso[1], 10),
      month: parseInt(iso[2], 10),
      day: parseInt(iso[3], 10),
    };
  }

  // Year-month only: YYYY-MM
  const isoYearMonth = cleaned.match(/^(\d{4})[-./](\d{1,2})$/);
  if (isoYearMonth) {
    return {
      year: parseInt(isoYearMonth[1], 10),
      month: parseInt(isoYearMonth[2], 10),
    };
  }

  // Year only: YYYY
  const yearOnly = cleaned.match(/^(\d{4})$/);
  if (yearOnly) {
    return { year: parseInt(yearOnly[1], 10) };
  }

  // DMY format: DD-MM-YYYY or DD/MM/YYYY
  const dmy = cleaned.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/);
  if (dmy) {
    return {
      year: parseInt(dmy[3], 10),
      month: parseInt(dmy[2], 10),
      day: parseInt(dmy[1], 10),
    };
  }

  // Fallback: extract any 4-digit year
  const yearMatch = cleaned.match(/(19|20)\d{2}/);
  if (yearMatch) {
    return { year: parseInt(yearMatch[0], 10) };
  }

  return null;
}
