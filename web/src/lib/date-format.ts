import { format, formatDistanceToNow } from "date-fns";
import { cs, enUS } from "date-fns/locale";
import type { Locale } from "date-fns";

const localeMap: Record<string, Locale> = {
  cs,
  en: enUS,
};

/**
 * Get the date-fns locale object for a locale string.
 * Returns enUS as fallback for unknown locales.
 */
export function getDateLocale(locale: string): Locale {
  return localeMap[locale] || enUS;
}

/**
 * Capitalize first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Pad number with leading figure space to width 2
 * Uses \u2007 (figure space) which has the same width as digits
 * for proper vertical alignment in tabular-nums contexts
 */
function padWithSpace(num: number): string {
  return num < 10 ? `\u2007${num}` : String(num);
}

/**
 * Get month name from month number (1-12)
 * Uses standalone form (nominative case): "Leden" not "Ledna"
 * Returns capitalized month name (e.g., "January" / "Leden")
 */
export function getMonthName(
  month: number,
  locale: string,
  short = false
): string {
  const date = new Date(2024, month - 1, 1);
  // Use LLLL for standalone month (nominative), not MMMM (genitive in Czech)
  const monthName = format(date, short ? "LLL" : "LLLL", {
    locale: localeMap[locale] || enUS,
  });
  return capitalize(monthName);
}

/**
 * Format a full date in medium style with month name.
 * Czech: "10. Ledna 2026" (genitive month, capitalized)
 * English: "Jan 10, 2026" (abbreviated month)
 */
export function formatMediumDate(
  year: number,
  month: number,
  day: number,
  locale: string
): string {
  const dateLocale = localeMap[locale] || enUS;
  const date = new Date(year, month - 1, day);

  if (locale === "cs") {
    // Czech: "10. Ledna 2026" - genitive month (MMMM), capitalized
    const monthName = format(date, "MMMM", { locale: dateLocale });
    return `${day}. ${capitalize(monthName)} ${year}`;
  } else {
    // English: "Jan 10, 2026"
    const monthAbbr = format(date, "MMM", { locale: dateLocale });
    return `${monthAbbr} ${day}, ${year}`;
  }
}

/**
 * Format a partial date (year, month, day - any can be null)
 * Returns locale-aware formatted string with space-padded numbers
 * Examples: "18.  6. 2005", "Mar 18, 2024", "Březen 2024", "2024"
 */
export function formatPartialDate(
  year: number | null | undefined,
  month: number | null | undefined,
  day: number | null | undefined,
  locale: string
): string {
  if (!year && !month && !day) return "";

  const dateLocale = localeMap[locale] || enUS;

  if (year && month && day) {
    // Full date: locale-aware with space padding
    if (locale === "cs") {
      // Czech: "18.  6. 2005" - space-padded day and month
      return `${padWithSpace(day)}. ${padWithSpace(month)}. ${year}`;
    } else {
      // English: "Mar 18, 2024" - space-padded day for alignment
      const date = new Date(year, month - 1, day);
      const monthAbbr = format(date, "MMM", { locale: dateLocale });
      return `${monthAbbr} ${padWithSpace(day)}, ${year}`;
    }
  }

  if (year && month) {
    // Month + Year - use standalone form, capitalize
    const date = new Date(year, month - 1, 1);
    const formatted = format(date, "LLLL yyyy", { locale: dateLocale });
    return capitalize(formatted);
  }

  // Year only
  return String(year);
}

/**
 * Format relative time with proper locale support.
 *
 * Use this instead of date-fns formatDistanceToNow directly to ensure
 * consistent server/client rendering with proper locale handling.
 *
 * @param date - Date to format (Date object, ISO string, or timestamp)
 * @param locale - Locale string ("cs" or "en")
 * @param options - Optional settings (addSuffix defaults to true)
 * @returns Relative time string like "2 days ago" or "před 2 dny"
 */
export function formatRelativeTime(
  date: Date | string | number,
  locale: string,
  options?: { addSuffix?: boolean }
): string {
  const dateObj =
    typeof date === "string" || typeof date === "number"
      ? new Date(date)
      : date;

  return formatDistanceToNow(dateObj, {
    addSuffix: options?.addSuffix ?? true,
    locale: localeMap[locale] || enUS,
  });
}

/**
 * Format a date to a localized string.
 *
 * Use this instead of toLocaleDateString() to ensure consistent
 * server/client rendering.
 *
 * @param date - Date to format (Date object, ISO string, or timestamp)
 * @param locale - Locale string ("cs" or "en")
 * @param formatStr - date-fns format string (default: "PP" for localized date)
 * @returns Formatted date string like "Apr 29, 2024" or "29. 4. 2024"
 */
export function formatLocalDate(
  date: Date | string | number,
  locale: string,
  formatStr = "PP"
): string {
  const dateObj =
    typeof date === "string" || typeof date === "number"
      ? new Date(date)
      : date;

  return format(dateObj, formatStr, {
    locale: localeMap[locale] || enUS,
  });
}
