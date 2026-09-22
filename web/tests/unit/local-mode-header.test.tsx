import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalModeHeader } from "@/components/offline/local-mode-header";

const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string } } | null,
  isOnline: true,
  headerProps: [] as Array<{ sessionRecovering?: boolean }>,
  resolveRefetch: null as (() => void) | null,
  refetch: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        mocks.resolveRefetch = resolve;
      }),
  ),
}));

vi.mock("@/components/header", () => ({
  Header: (props: { sessionRecovering?: boolean }) => {
    mocks.headerProps.push(props);
    return <div data-testid="header" />;
  },
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
    mocks.headerProps = [];
    mocks.resolveRefetch = null;
    mocks.refetch.mockClear();
  });

  it("keeps the session unknown from the first online render until the refetch settles", async () => {
    mocks.isOnline = false;
    const { rerender } = render(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();
    mocks.headerProps = [];

    mocks.isOnline = true;
    rerender(<LocalModeHeader />);
    // Every render committed after the flip carried the recovering flag.
    expect(mocks.headerProps.length).toBeGreaterThan(0);
    expect(mocks.headerProps.every((props) => props.sessionRecovering === true)).toBe(true);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.resolveRefetch?.();
      await Promise.resolve();
    });
    expect(mocks.headerProps.at(-1)?.sessionRecovering).toBe(false);

    // Still no session and still online: no busy loop.
    rerender(<LocalModeHeader />);
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch when the document started online or already has a session", () => {
    render(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(mocks.headerProps.at(-1)?.sessionRecovering).toBe(false);

    mocks.session = { user: { id: "u1" } };
    mocks.isOnline = false;
    const { rerender } = render(<LocalModeHeader />);
    mocks.isOnline = true;
    rerender(<LocalModeHeader />);
    expect(mocks.refetch).not.toHaveBeenCalled();
  });
});
