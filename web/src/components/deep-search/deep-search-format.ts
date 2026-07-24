"use client";

import {
  formatLocalDate,
  formatPartialDate,
  formatRelativeTime,
} from "@/lib/date-format";

export function formatJobDate(
  value: string | null | undefined,
  locale: string,
  unavailableLabel: string
) {
  if (!value) return unavailableLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return unavailableLabel;
  const datePart = formatPartialDate(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    locale
  );
  return `${datePart} ${formatLocalDate(date, locale, "HH:mm")}`;
}

export function formatJobRelativeDate(
  value: string | null | undefined,
  locale: string,
  unavailableLabel: string
) {
  if (!value) return unavailableLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return unavailableLabel;
  return formatRelativeTime(date, locale);
}

export function formatJobDuration(
  startValue: string | null | undefined,
  endValue: string | null | undefined,
  unavailableLabel: string
) {
  const start = parseDateMs(startValue);
  if (start === null) return unavailableLabel;
  const end = parseDateMs(endValue) ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function stringifyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function parseDateMs(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
