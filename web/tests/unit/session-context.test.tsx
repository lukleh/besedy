"use client";

import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "@/contexts/session-context";

const useBetterAuthSessionMock = vi.fn();
const subscribeToAuthEventsMock = vi.fn((_handler: () => void) => vi.fn());

vi.mock("@/lib/auth/client", () => ({
  useSession: () => useBetterAuthSessionMock(),
  subscribeToAuthEvents: (handler: () => void) => subscribeToAuthEventsMock(handler),
}));

function RefetchConsumer({
  onRender,
}: {
  onRender: (refetch: () => Promise<void>) => void;
}) {
  const { refetch } = useSession();
  onRender(refetch);
  return null;
}

describe("SessionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps refetch stable across rerenders and calls the latest Better Auth refetch", async () => {
    const firstRefetch = vi.fn().mockResolvedValue(undefined);
    const secondRefetch = vi.fn().mockResolvedValue(undefined);
    const seenRefetches: Array<() => Promise<void>> = [];
    let betterAuthSession = {
      data: null,
      isPending: false,
      refetch: firstRefetch,
    };

    useBetterAuthSessionMock.mockImplementation(() => betterAuthSession);

    const { rerender } = render(
      <SessionProvider initialSession={null}>
        <RefetchConsumer onRender={(refetch) => seenRefetches.push(refetch)} />
      </SessionProvider>
    );

    betterAuthSession = {
      data: null,
      isPending: true,
      refetch: secondRefetch,
    };

    rerender(
      <SessionProvider initialSession={null}>
        <RefetchConsumer onRender={(refetch) => seenRefetches.push(refetch)} />
      </SessionProvider>
    );

    expect(seenRefetches.at(-1)).toBe(seenRefetches[0]);

    await act(async () => {
      await seenRefetches.at(-1)?.();
    });

    expect(firstRefetch).not.toHaveBeenCalled();
    expect(secondRefetch).toHaveBeenCalledTimes(1);
  });
});
