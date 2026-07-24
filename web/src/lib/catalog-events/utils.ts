export type EventSortKey =
  | "title"
  | "date"
  | "sortOrder"
  | "recordingCount"
  | "location"
  | "released";
export type SortDirection = "asc" | "desc";

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  take: number | undefined;
}

export function deriveEventTitle(
  locationName: string,
  dateYear: number,
  dateMonth: number | null,
  dateDay: number | null,
  sessionIndex = 1
): string {
  const safeLocation = locationName.trim() || "Unknown location";
  const sessionSuffix = sessionIndex > 1 ? `, session ${sessionIndex}` : "";
  if (dateMonth && dateDay) {
    return `${safeLocation}, ${dateDay} ${MONTH_SHORT[dateMonth - 1]} ${dateYear}${sessionSuffix}`;
  }
  if (dateMonth) {
    return `${safeLocation}, ${MONTH_SHORT[dateMonth - 1]} ${dateYear}${sessionSuffix}`;
  }
  return `${safeLocation}, ${dateYear}${sessionSuffix}`;
}

export function formatSessionLabel(sessionIndex: number): string | null {
  return sessionIndex > 1 ? `Session ${sessionIndex}` : null;
}

export function normalizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseSortDirection(value: string | null): SortDirection {
  return value === "asc" || value === "desc" ? value : "desc";
}

export function parseEventSortKey(value: string | null): EventSortKey {
  if (
    value === "title" ||
    value === "date" ||
    value === "sortOrder" ||
    value === "recordingCount" ||
    value === "location" ||
    value === "released"
  ) {
    return value;
  }
  return "date";
}

export function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function parsePagination(
  searchParams: URLSearchParams,
  defaults: { page: number; limit: number; maxLimit: number } = {
    page: 1,
    limit: 50,
    maxLimit: 200,
  }
): Pagination {
  const rawPage = Number.parseInt(searchParams.get("page") ?? "", 10);
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : defaults.page;

  let limit = defaults.limit;
  if (Number.isFinite(rawLimit)) {
    if (rawLimit === 0) {
      limit = 0;
    } else if (rawLimit > 0) {
      limit = Math.min(defaults.maxLimit, rawLimit);
    }
  }

  const take = limit === 0 ? undefined : limit;
  const skip = take === undefined ? 0 : (page - 1) * take;

  return { page, limit, skip, take };
}

export function parseDurationHmsToSeconds(durationHms: string | null): number {
  if (!durationHms) return -1;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(durationHms);
  if (!match) return -1;
  const [, hours, minutes, seconds] = match;
  return (
    Number.parseInt(hours, 10) * 3600 +
    Number.parseInt(minutes, 10) * 60 +
    Number.parseInt(seconds, 10)
  );
}
