import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalModeHeader } from "@/components/offline/local-mode-header";

const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  isOnline: true,
  refetch: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ session: mocks.session, isPending: false, refetch: mocks.refetch }),
}));

vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => ({ isOnline: mocks.isOnline }),
}));

describe("LocalModeHeader", () => {
  beforeEach(() => {
    mocks.session = null;
    mocks.isOnline = true;
    mocks.refetch.mockClear();
  });

  it("requests the session again when the connection returns without one", () => {
    mocks.isOnline = false;
    const { rerender } = render(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();

    mocks.isOnline = true;
    rerender(<LocalModeHeader />);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    // Still no session and still online: no busy loop.
    rerender(<LocalModeHeader />);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the document started online or already has a session", () => {
    render(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();

    mocks.session = { user: { id: "u1" } };
    mocks.isOnline = false;
    const { rerender } = render(<LocalModeHeader />);
    mocks.isOnline = true;
    rerender(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();
  });
});
