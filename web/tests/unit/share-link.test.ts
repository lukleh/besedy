// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareOrCopyLink } from "@/lib/share-link";

const URL_TO_SHARE = "https://besedy.example/catalog/c/recording/h/correction?segment=s";
const share = vi.fn();
const writeText = vi.fn();
let coarsePointer = false;

beforeEach(() => {
  share.mockReset().mockResolvedValue(undefined);
  writeText.mockReset().mockResolvedValue(undefined);
  coarsePointer = false;
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: query === "(pointer: coarse)" && coarsePointer }) as MediaQueryList,
  });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("shareOrCopyLink", () => {
  it("opens the share sheet on a touch device", async () => {
    coarsePointer = true;
    await expect(shareOrCopyLink(URL_TO_SHARE)).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith({ url: URL_TO_SHARE });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies on a desktop even where the browser has a share sheet", async () => {
    await expect(shareOrCopyLink(URL_TO_SHARE)).resolves.toBe("copied");
    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(URL_TO_SHARE);
  });

  it("copies on a touch device without a share sheet", async () => {
    coarsePointer = true;
    Reflect.deleteProperty(navigator, "share");
    await expect(shareOrCopyLink(URL_TO_SHARE)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(URL_TO_SHARE);
  });

  it("does nothing more when the person closes the share sheet", async () => {
    coarsePointer = true;
    share.mockRejectedValue(new DOMException("closed", "AbortError"));
    await expect(shareOrCopyLink(URL_TO_SHARE)).resolves.toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies when the share sheet is refused", async () => {
    coarsePointer = true;
    share.mockRejectedValue(new DOMException("blocked", "NotAllowedError"));
    await expect(shareOrCopyLink(URL_TO_SHARE)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(URL_TO_SHARE);
  });

  it("rejects when the link can be neither shared nor copied", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    await expect(shareOrCopyLink(URL_TO_SHARE)).rejects.toThrow("denied");
  });
});
