import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "@/components/header";

const mocks = vi.hoisted(() => ({
  session: {
    user: { id: "user-1", name: "Listener" },
  } as { user: { id: string; name: string } } | null,
  downloadSnapshot: {
    hydrated: true,
    records: [] as Array<{ key: string }>,
  },
  isOnline: true,
  sessionPending: false,
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
  useCatalogRouteState: () => ({
    isAuthPage: false,
    isDetailRoute: false,
    routeGroupId: null,
    backTargetUrl: "/catalog",
    backTargetLabel: "Back",
  }),
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

describe("Header", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "user-1", name: "Listener" } };
    mocks.downloadSnapshot = { hydrated: true, records: [] };
    mocks.isOnline = true;
    mocks.sessionPending = false;
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
    expect(indicator).toHaveAttribute("href", "/downloads");
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

    expect(screen.getByTestId("header-downloads")).toHaveAttribute("href", "/downloads");
  });

  it("provides signed-in users a direct Downloads shortcut", () => {
    render(<Header />);

    const shortcut = screen.getByTestId("header-downloads");
    expect(shortcut).toHaveAttribute("href", "/downloads");
    expect(shortcut).toHaveAccessibleName("nav.downloads");
    expect(shortcut.querySelector(".lucide-download")).toBeInTheDocument();
  });

  it("does not expose the protected shortcut while signed out", () => {
    mocks.session = null;

    render(<Header />);

    expect(screen.queryByTestId("header-downloads")).not.toBeInTheDocument();
  });

  it("shows the number of device-local Downloads entries in grayscale", () => {
    mocks.downloadSnapshot = {
      hydrated: true,
      records: [{ key: "one" }, { key: "two" }, { key: "three" }],
    };

    render(<Header />);

    const shortcut = screen.getByTestId("header-downloads");
    const badge = screen.getByTestId("downloads-badge");
    expect(shortcut).toHaveAccessibleName("nav.downloads (3)");
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveClass("bg-foreground", "text-background");
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
