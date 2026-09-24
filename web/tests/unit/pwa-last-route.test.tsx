import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLastRoute,
  resolveRestorableRoute,
  saveLastRoute,
} from "@/lib/pwa/last-route";
import { LastRouteTracker } from "@/components/pwa/last-route-tracker";

const navigation = vi.hoisted(() => ({
  pathname: "/catalog/20260101_120000",
  search: "",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function readCookie(): string | null {
  const entry = document.cookie
    .split("; ")
    .find((part) => part.startsWith("besedy_last_route="));
  return entry ? decodeURIComponent(entry.slice("besedy_last_route=".length)) : null;
}

describe("resolveRestorableRoute", () => {
  it.each([
    "/catalog/20260101_120000",
    "/catalog/20260101_120000?tab=recordings",
    `/catalog/20260101_120000/recording/${"a".repeat(64)}`,
    "/catalog/20260101_120000/event/42",
    "/settings",
    "/settings/notifications",
  ])("keeps %s", (route) => {
    expect(resolveRestorableRoute(route)).toBe(route);
  });

  it("drops the hash fragment", () => {
    expect(resolveRestorableRoute("/catalog/c1/event/42#transcript")).toBe(
      "/catalog/c1/event/42"
    );
  });

  it.each([
    null,
    undefined,
    "",
    "/catalog",
    "/catalog/",
    "/catalog?launch=pwa",
    "/",
    "/auth/signin",
    "/api/catalogs",
    "/admin/users",
    "/downloads",
    "/settingsx",
    "//evil.example.com/catalog/c1",
    "https://evil.example.com/catalog/c1",
    "/\\evil.example.com",
    "/catalog/c1\n",
    "catalog/c1",
    `/catalog/${"x".repeat(2048)}`,
  ])("rejects %s", (route) => {
    expect(resolveRestorableRoute(route)).toBeNull();
  });
});

describe("last route cookie", () => {
  beforeEach(() => {
    clearLastRoute();
  });

  it("saves restorable routes and ignores the rest", () => {
    saveLastRoute("/catalog/c1/event/42?t=90");
    expect(readCookie()).toBe("/catalog/c1/event/42?t=90");

    saveLastRoute("/auth/signin");
    expect(readCookie()).toBe("/catalog/c1/event/42?t=90");
  });

  it("clears the saved route", () => {
    saveLastRoute("/catalog/c1");
    clearLastRoute();
    expect(readCookie()).toBeNull();
  });
});

describe("LastRouteTracker", () => {
  beforeEach(() => {
    clearLastRoute();
  });

  afterEach(() => {
    navigation.pathname = "/catalog/20260101_120000";
    navigation.search = "";
  });

  it("records the current path with its query", () => {
    navigation.pathname = "/catalog/c1/recording/abc";
    navigation.search = "variant=nemo";

    render(<LastRouteTracker />);

    expect(readCookie()).toBe("/catalog/c1/recording/abc?variant=nemo");
  });

  it("updates the record on navigation", () => {
    const { rerender } = render(<LastRouteTracker />);
    expect(readCookie()).toBe("/catalog/20260101_120000");

    navigation.pathname = "/catalog/20260101_120000/event/7";
    rerender(<LastRouteTracker />);

    expect(readCookie()).toBe("/catalog/20260101_120000/event/7");
  });
});
