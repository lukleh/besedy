import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  signInSocial: vi.fn(),
  oauth2Consent: vi.fn(),
  useSession: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    signIn: {
      social: mocks.signInSocial,
    },
    oauth2: {
      consent: mocks.oauth2Consent,
    },
    useSession: mocks.useSession,
    signOut: mocks.signOut,
    getSession: mocks.getSession,
  })),
}));

describe("auth client", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.signInSocial.mockReset();
    mocks.oauth2Consent.mockReset();
    mocks.signOut.mockReset();
    delete process.env.NEXT_PUBLIC_APP_ENV;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses mock OAuth flow in non-production environments", async () => {
    const { signInWithOAuth } = await import("@/lib/auth/client");

    await signInWithOAuth("/catalog");

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "mock-oauth",
      callbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
      errorCallbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
    });
  });

  it("uses Google OAuth flow in production", async () => {
    process.env.NEXT_PUBLIC_APP_ENV = "production";

    const { signInWithOAuth } = await import("@/lib/auth/client");

    await signInWithOAuth("/catalog");

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
      errorCallbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
    });
  });

  it("uses Google OAuth flow when mock OAuth is explicitly disabled", async () => {
    const { signInWithOAuth } = await import("@/lib/auth/client");

    await signInWithOAuth("/catalog", { useMockOAuth: false });

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
      errorCallbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
    });
  });

  it("sanitizes unsafe callback paths for mock OAuth flow", async () => {
    const { signInWithOAuth } = await import("@/lib/auth/client");

    await signInWithOAuth("https://evil.example");

    expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: "mock-oauth",
      callbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
      errorCallbackURL: "/auth/complete?callbackUrl=%2Fcatalog",
    });
  });

  it("allows only safe app-relative callback paths", async () => {
    const { sanitizeAppRelativePath, sanitizePostAuthCallbackPath } = await import(
      "@/lib/auth/client"
    );

    expect(sanitizeAppRelativePath("/labs")).toBe("/labs");
    expect(sanitizeAppRelativePath("https://evil.example")).toBe("/catalog");
    expect(sanitizeAppRelativePath("//evil.example")).toBe("/catalog");
    expect(sanitizeAppRelativePath("/\\evil")).toBe("/catalog");
    expect(sanitizeAppRelativePath("/catalog/../api/auth/session")).toBe("/api/auth/session");
    expect(sanitizeAppRelativePath("/labs/../../auth/signin")).toBe("/auth/signin");
    expect(sanitizePostAuthCallbackPath("/labs")).toBe("/labs");
    expect(sanitizePostAuthCallbackPath("/auth")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/auth/signin")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/api")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/api/auth/session")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/catalog/../api/auth/session")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/labs/../../auth/signin")).toBe("/catalog");
    expect(sanitizePostAuthCallbackPath("/%2e%2e/api/auth/session")).toBe("/catalog");
  });

  it("surfaces OAuth bootstrap failures", async () => {
    mocks.signInSocial.mockRejectedValueOnce(new Error("boom"));

    const { signInWithOAuth } = await import("@/lib/auth/client");

    await expect(signInWithOAuth("/catalog")).rejects.toThrow("boom");
  });

  it("continues MCP authorization with the selected sign-in provider", async () => {
    const { signInForMcpAuthorization } = await import("@/lib/auth/client");

    await signInForMcpAuthorization(false);

    expect(mocks.signInSocial).toHaveBeenCalledWith({ provider: "google" });
  });

  it("submits the MCP consent decision through the OAuth provider client", async () => {
    const { respondToMcpConsent } = await import("@/lib/auth/client");

    await respondToMcpConsent(true);

    expect(mocks.oauth2Consent).toHaveBeenCalledWith({ accept: true });
  });

  it("clears offline caches during sign out before redirecting", async () => {
    const keys = vi.fn().mockResolvedValue([
      "besedy-audio-v3",
      "besedy-transcript-v1",
      "unrelated-cache",
    ]);
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { keys, delete: del });
    Object.defineProperty(window, "caches", {
      value: (globalThis as { caches: unknown }).caches,
      configurable: true,
    });

    const postMessage = vi.fn();
    const close = vi.fn();
    class BroadcastChannelMock {
      postMessage = postMessage;
      close = close;
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelMock);

    const { signOutAndRedirect } = await import("@/lib/auth/client");

    await signOutAndRedirect().catch(() => {
      // jsdom does not implement full navigation; ignore redirect errors.
    });

    expect(mocks.signOut).toHaveBeenCalled();
    expect(keys).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("besedy-audio-v3");
    expect(del).toHaveBeenCalledWith("besedy-transcript-v1");
    expect(del).not.toHaveBeenCalledWith("unrelated-cache");
    expect(postMessage).toHaveBeenCalledWith({ type: "signout" });
  });

  it("clears offline caches on cross-tab signout events", async () => {
    const keys = vi.fn().mockResolvedValue(["besedy-audio-v3"]);
    const del = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("caches", { keys, delete: del });
    Object.defineProperty(window, "caches", {
      value: (globalThis as { caches: unknown }).caches,
      configurable: true,
    });

    const handlers = new Set<(event: MessageEvent<unknown>) => void>();
    class BroadcastChannelMock {
      addEventListener(_type: string, handler: (event: MessageEvent<unknown>) => void) {
        handlers.add(handler);
      }
      removeEventListener(_type: string, handler: (event: MessageEvent<unknown>) => void) {
        handlers.delete(handler);
      }
      postMessage = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal("BroadcastChannel", BroadcastChannelMock);

    const { subscribeToAuthEvents } = await import("@/lib/auth/client");
    const onSignOut = vi.fn();
    const unsubscribe = subscribeToAuthEvents(onSignOut);

    for (const handler of handlers) {
      handler({ data: { type: "signout" } } as MessageEvent<unknown>);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(keys).toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("besedy-audio-v3");
    expect(onSignOut).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
