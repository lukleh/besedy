import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "user-1", name: "Listener" },
  } as { user: { id: string; name: string } } | null,
  downloadSnapshot: {
    hydrated: true,
    records: [] as Array<{ key: string; status?: string }>,
  },
  isOnline: true,
  sessionPending: false,
  pathname: "/catalog/c1",
  search: "tab=events",
  backTargetUrl: null as string | null,
  routeOptions: undefined as { downloadsIsHome?: boolean; offline?: boolean } | undefined,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: mocks.session,
    isPending: mocks.sessionPending,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-catalog-route-state", () => ({
  useCatalogRouteState: (options?: { downloadsIsHome?: boolean; offline?: boolean }) => {
    mocks.routeOptions = options;
    return {
      isAuthPage: false,
      routeGroupId: null,
      backTargetUrl: mocks.backTargetUrl,
      backTargetLabel: "Back",
    };
  },
}));

vi.mock("@/hooks/use-catalogs", () => ({
  useCatalogs: () => ({ data: [] }),
}));

vi.mock("@/hooks/use-active-group", () => ({
  useActiveGroup: () => ({ activeGroupId: null }),
}));

vi.mock("@/hooks/use-effective-catalog-id", () => ({
  useEffectiveCatalogId: () => ({ effectiveCatalogId: null }),
}));

vi.mock("@/hooks/use-catalog-access-summary", () => ({
  useCatalogAccessSummary: () => ({ data: null }),
}));

vi.mock("@/hooks/use-downloads", () => ({
  useDownloadManager: () => mocks.downloadSnapshot,
}));

vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => ({ isOnline: mocks.isOnline }),
}));

vi.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/text-size-toggle", () => ({ TextSizeToggle: () => null }));
vi.mock("@/components/language-switcher", () => ({
  LanguageSwitcher: () => <div data-testid="language-switcher" />,
}));
vi.mock("@/components/auth/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));
vi.mock("@/components/radio/radio-button", () => ({ RadioButton: () => null }));
vi.mock("@/components/notifications/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/components/update-indicator", () => ({ UpdateIndicator: () => null }));
vi.mock("@/lib/support-email", () => ({ openSupportEmail: vi.fn() }));

const DOWNLOADS_FROM_CATALOG = "/downloads?backTo=%2Fcatalog%2Fc1%3Ftab%3Devents";

describe("Header", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "user-1", name: "Listener" } };
    mocks.downloadSnapshot = { hydrated: true, records: [] };
    mocks.isOnline = true;
    mocks.sessionPending = false;
    mocks.pathname = "/catalog/c1";
    mocks.search = "tab=events";
    mocks.backTargetUrl = null;
    mocks.routeOptions = undefined;
  });

  it("shows the back control in place of the logo when the page has a back target", () => {
    const { rerender } = render(<Header />);
    expect(screen.getByRole("link", { name: "Besedy home" })).toBeInTheDocument();
    expect(screen.queryByTestId("header-back")).not.toBeInTheDocument();

    mocks.backTargetUrl = "/downloads";
    rerender(<Header />);
    expect(screen.getByTestId("header-back")).toHaveAttribute("href", "/downloads");
    expect(screen.queryByRole("link", { name: "Besedy home" })).not.toBeInTheDocument();
  });

  it("treats Downloads as home only offline or once the listener is known to be signed out", () => {
    render(<Header />);
    expect(mocks.routeOptions).toEqual({ downloadsIsHome: false, offline: false });

    mocks.isOnline = false;
    render(<Header />);
    expect(mocks.routeOptions).toEqual({ downloadsIsHome: true, offline: true });

    mocks.isOnline = true;
    mocks.session = null;
    mocks.sessionPending = true;
    render(<Header />);
    expect(mocks.routeOptions).toEqual({ downloadsIsHome: false, offline: false });

    render(<Header sessionRecovering />);
    expect(mocks.routeOptions).toEqual({ downloadsIsHome: false, offline: false });

    mocks.sessionPending = false;
    render(<Header />);
    expect(mocks.routeOptions).toEqual({ downloadsIsHome: true, offline: false });
  });

  it("hides sign-in and the signed-out toggles while the session request is still pending", () => {
    mocks.session = null;
    mocks.sessionPending = true;

    render(<Header />);

    expect(screen.queryByTestId("user-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("language-switcher")).not.toBeInTheDocument();
  });

  it("shows the crossed-Wi-Fi indicator only while offline, leading to Downloads", () => {
    const { rerender } = render(<Header />);
    expect(screen.queryByTestId("offline-indicator")).not.toBeInTheDocument();

    mocks.isOnline = false;
    rerender(<Header />);
    const indicator = screen.getByTestId("offline-indicator");
    expect(indicator).toHaveAttribute("href", DOWNLOADS_FROM_CATALOG);
    expect(indicator).toHaveAccessibleName("offline.offlineMode");
    expect(indicator.querySelector(".lucide-wifi-off")).toBeInTheDocument();
  });

  it("hides sign-in and the signed-out toggles while offline without a session", () => {
    mocks.session = null;
    mocks.isOnline = false;

    render(<Header />);

    expect(screen.queryByTestId("user-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("language-switcher")).not.toBeInTheDocument();
    expect(screen.getByTestId("offline-indicator")).toBeInTheDocument();
  });

  it("keeps the account area empty while the session is being recovered after a reconnect", () => {
    mocks.session = null;

    render(<Header sessionRecovering />);

    expect(screen.queryByTestId("user-menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("language-switcher")).not.toBeInTheDocument();
  });

  it("keeps the Downloads shortcut in the session-free shell when downloads exist", () => {
    mocks.session = null;
    mocks.downloadSnapshot = { hydrated: true, records: [{ key: "one" }] };

    render(<Header />);

    expect(screen.getByTestId("header-downloads")).toHaveAttribute("href", DOWNLOADS_FROM_CATALOG);
  });

  it("provides signed-in users a direct Downloads shortcut", () => {
    render(<Header />);

    const shortcut = screen.getByTestId("header-downloads");
    expect(shortcut).toHaveAttribute("href", DOWNLOADS_FROM_CATALOG);
    expect(shortcut).toHaveAccessibleName("nav.downloads");
    expect(shortcut.querySelector(".lucide-download")).toBeInTheDocument();
  });

  it("links Downloads without an origin while Downloads is open", () => {
    mocks.pathname = "/downloads";
    mocks.search = "";

    render(<Header />);

    expect(screen.getByTestId("header-downloads")).toHaveAttribute("href", "/downloads");
  });

  it("keeps the open Downloads page's own origin on its shortcut", () => {
    mocks.pathname = "/downloads";
    mocks.search = "backTo=%2Fcatalog%2Fc1%2Fevent%2F7";

    render(<Header />);

    expect(screen.getByTestId("header-downloads")).toHaveAttribute(
      "href",
      "/downloads?backTo=%2Fcatalog%2Fc1%2Fevent%2F7",
    );
  });

  it("gives signed-in users a Bookmarks shortcut that returns to where it was opened", () => {
    render(<Header />);

    const shortcut = screen.getByTestId("header-bookmarks");
    expect(shortcut).toHaveAttribute("href", "/bookmarks?backTo=%2Fcatalog%2Fc1%3Ftab%3Devents");
    expect(shortcut).toHaveAccessibleName("nav.bookmarks");
    expect(shortcut.querySelector(".lucide-bookmark")).toBeInTheDocument();
  });

  it("has no Bookmarks shortcut while signed out or offline", () => {
    mocks.session = null;
    const { rerender } = render(<Header />);
    expect(screen.queryByTestId("header-bookmarks")).not.toBeInTheDocument();

    mocks.session = { user: { id: "user-1", name: "Listener" } };
    mocks.isOnline = false;
    rerender(<Header />);
    expect(screen.queryByTestId("header-bookmarks")).not.toBeInTheDocument();
  });

  it("does not expose the protected shortcut while signed out", () => {
    mocks.session = null;

    render(<Header />);

    expect(screen.queryByTestId("header-downloads")).not.toBeInTheDocument();
  });

  it("shows the number of playable Downloads entries in grayscale", () => {
    mocks.downloadSnapshot = {
      hydrated: true,
      records: [
        { key: "one", status: "complete" },
        { key: "two", status: "complete" },
        { key: "three", status: "complete" },
      ],
    };

    render(<Header />);

    const shortcut = screen.getByTestId("header-downloads");
    const badge = screen.getByTestId("downloads-badge");
    expect(shortcut).toHaveAccessibleName("nav.downloads (3)");
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveClass("bg-foreground", "text-background");
  });

  it("leaves downloads that cannot play yet out of the badge", () => {
    mocks.downloadSnapshot = {
      hydrated: true,
      records: [
        { key: "one", status: "complete" },
        { key: "two", status: "queued" },
        { key: "three", status: "downloading" },
        { key: "four", status: "paused" },
        { key: "five", status: "error" },
      ],
    };

    render(<Header />);

    expect(screen.getByTestId("header-downloads")).toHaveAccessibleName("nav.downloads (1)");
    expect(screen.getByTestId("downloads-badge")).toHaveTextContent("1");
  });

  it("keeps the shell shortcut without a badge when nothing is playable", () => {
    mocks.session = null;
    mocks.downloadSnapshot = {
      hydrated: true,
      records: [{ key: "one", status: "error" }],
    };

    render(<Header />);

    expect(screen.getByTestId("header-downloads")).toHaveAccessibleName("nav.downloads");
    expect(screen.queryByTestId("downloads-badge")).not.toBeInTheDocument();
  });

  it("waits for download state hydration before showing the badge", () => {
    mocks.downloadSnapshot = {
      hydrated: false,
      records: [{ key: "one" }],
    };

    render(<Header />);

    expect(screen.queryByTestId("downloads-badge")).not.toBeInTheDocument();
  });
});
