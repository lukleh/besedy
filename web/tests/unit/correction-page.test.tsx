import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CorrectionPage from "@/app/(app)/catalog/[catalogId]/recording/[hash]/correction/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRecordingCapability: vi.fn(),
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  workspace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/access/capabilities", () => ({ getRecordingCapability: mocks.getRecordingCapability }));
vi.mock("@/components/correction/correction-workspace", () => ({
  CorrectionWorkspace: (props: unknown) => {
    mocks.workspace(props);
    return <div data-testid="correction-workspace" />;
  },
}));

const catalogId = "20261104_120000";
const hash = "a".repeat(64);
const path = `/catalog/${catalogId}/recording/${hash}/correction`;
const params = () => Promise.resolve({ catalogId, hash });
const capability = {
  catalogExists: true,
  hasAccess: true,
  canAccessRecording: true,
  canCorrectTranscripts: true,
  canPublishTranscript: false,
};

function redirectedCallback() {
  const url = new URL(mocks.redirect.mock.calls[0][0], "https://besedy.org");
  expect(url.pathname).toBe("/auth/signin");
  return url.searchParams.get("callbackUrl");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.getRecordingCapability.mockResolvedValue(capability);
});

describe("CorrectionPage", () => {
  it("keeps a direct segment link through sign-in without checking recording permissions first", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(CorrectionPage({
      params: params(), searchParams: Promise.resolve({ segment: "span-1" }),
    })).rejects.toThrow("NEXT_REDIRECT:");

    expect(redirectedCallback()).toBe(`${path}?segment=span-1`);
    expect(mocks.getRecordingCapability).not.toHaveBeenCalled();
  });

  it("accepts callers without searchParams and returns them to the recording's correction page", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(CorrectionPage({ params: params() })).rejects.toThrow("NEXT_REDIRECT:");
    expect(redirectedCallback()).toBe(path);
  });

  it("preserves only the first duplicate segment value", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(CorrectionPage({
      params: params(), searchParams: Promise.resolve({ segment: ["span-first", "span-second"] }),
    })).rejects.toThrow("NEXT_REDIRECT:");
    expect(redirectedCallback()).toBe(`${path}?segment=span-first`);
  });

  it("retains a validated explicit origin alongside the segment on the sign-in return", async () => {
    mocks.getSession.mockResolvedValue(null);
    const backTo = `/catalog/${catalogId}/correction?filter=mine`;
    await expect(CorrectionPage({
      params: params(), searchParams: Promise.resolve({ segment: "span-1", backTo: [backTo, "/downloads"] }),
    })).rejects.toThrow("NEXT_REDIRECT:");

    const callback = new URL(redirectedCallback()!, "https://besedy.org");
    expect(callback.pathname).toBe(path);
    expect(callback.searchParams.get("segment")).toBe("span-1");
    expect(callback.searchParams.get("backTo")).toBe(backTo);
  });

  it.each(["https://example.com/elsewhere", "//example.com/elsewhere", "/api/auth/session", "/auth/signin"])(
    "omits the unsafe origin %s from the local sign-in return",
    async (backTo) => {
      mocks.getSession.mockResolvedValue(null);
      await expect(CorrectionPage({
        params: params(), searchParams: Promise.resolve({ segment: "span-1", backTo }),
      })).rejects.toThrow("NEXT_REDIRECT:");
      expect(redirectedCallback()).toBe(`${path}?segment=span-1`);
    }
  );

  it("treats an untrusted segment as query data and ignores a supplied callbackUrl", async () => {
    mocks.getSession.mockResolvedValue(null);
    const segment = "https://example.com/?x=1&callbackUrl=//example.com/#anchor";
    await expect(CorrectionPage({
      params: params(), searchParams: Promise.resolve({ segment, callbackUrl: "https://example.com/" }),
    })).rejects.toThrow("NEXT_REDIRECT:");

    const callback = new URL(redirectedCallback()!, "https://besedy.org");
    expect(callback.pathname).toBe(path);
    expect(callback.searchParams.get("segment")).toBe(segment);
    expect([...callback.searchParams.keys()]).toEqual(["segment"]);
    expect(callback.hash).toBe("");
  });

  it.each(["catalogExists", "hasAccess", "canAccessRecording", "canCorrectTranscripts"])(
    "keeps the %s gate for an authenticated segment link",
    async (denied) => {
      mocks.getRecordingCapability.mockResolvedValue({ ...capability, [denied]: false });
      await expect(CorrectionPage({
        params: params(), searchParams: Promise.resolve({ segment: "span-1" }),
      })).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.getRecordingCapability).toHaveBeenCalledWith(catalogId, hash, "user-1");
      expect(mocks.redirect).not.toHaveBeenCalled();
    }
  );

  it.each([false, true])("opens the existing workspace with publishing capability %s", async (canPublishTranscript) => {
    mocks.getRecordingCapability.mockResolvedValue({ ...capability, canPublishTranscript });
    render(await CorrectionPage({ params: params(), searchParams: Promise.resolve({ segment: "span-1" }) }));

    expect(screen.getByTestId("correction-workspace")).toBeInTheDocument();
    expect(mocks.workspace).toHaveBeenCalledWith({ catalogId, hash, userId: "user-1", canPublish: canPublishTranscript });
    expect(mocks.getSession.mock.invocationCallOrder[0]).toBeLessThan(mocks.getRecordingCapability.mock.invocationCallOrder[0]);
  });
});
