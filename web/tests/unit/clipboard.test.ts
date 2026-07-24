import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyToClipboard } from "@/lib/clipboard";

describe("copyToClipboard", () => {
  const originalNavigator = global.navigator;
  const originalDocument = global.document;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore originals
    Object.defineProperty(global, "navigator", {
      value: originalNavigator,
      writable: true,
    });
    Object.defineProperty(global, "document", {
      value: originalDocument,
      writable: true,
    });
  });

  describe("modern clipboard API", () => {
    it("uses navigator.clipboard.writeText when available", async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);

      Object.defineProperty(global, "navigator", {
        value: {
          clipboard: {
            writeText: writeTextMock,
          },
        },
        writable: true,
      });

      await copyToClipboard("test text");

      expect(writeTextMock).toHaveBeenCalledWith("test text");
    });

    it("handles clipboard API errors", async () => {
      const writeTextMock = vi.fn().mockRejectedValue(new Error("Permission denied"));

      Object.defineProperty(global, "navigator", {
        value: {
          clipboard: {
            writeText: writeTextMock,
          },
        },
        writable: true,
      });

      await expect(copyToClipboard("test text")).rejects.toThrow("Permission denied");
    });
  });

  describe("fallback for older browsers", () => {
    let mockTextarea: {
      value: string;
      style: { position: string; opacity: string };
      select: ReturnType<typeof vi.fn>;
    };
    let appendChildMock: ReturnType<typeof vi.fn>;
    let removeChildMock: ReturnType<typeof vi.fn>;
    let execCommandMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Remove clipboard API to trigger fallback
      Object.defineProperty(global, "navigator", {
        value: {},
        writable: true,
      });

      mockTextarea = {
        value: "",
        style: { position: "", opacity: "" },
        select: vi.fn(),
      };

      appendChildMock = vi.fn();
      removeChildMock = vi.fn();
      execCommandMock = vi.fn().mockReturnValue(true);

      Object.defineProperty(global, "document", {
        value: {
          createElement: vi.fn().mockReturnValue(mockTextarea),
          body: {
            appendChild: appendChildMock,
            removeChild: removeChildMock,
          },
          execCommand: execCommandMock,
        },
        writable: true,
      });
    });

    it("creates hidden textarea with text content", async () => {
      await copyToClipboard("fallback text");

      expect(mockTextarea.value).toBe("fallback text");
      expect(mockTextarea.style.position).toBe("fixed");
      expect(mockTextarea.style.opacity).toBe("0");
    });

    it("appends textarea to body, selects, and copies", async () => {
      await copyToClipboard("copy me");

      expect(appendChildMock).toHaveBeenCalledWith(mockTextarea);
      expect(mockTextarea.select).toHaveBeenCalled();
      expect(execCommandMock).toHaveBeenCalledWith("copy");
    });

    it("removes textarea after copying", async () => {
      await copyToClipboard("cleanup test");

      expect(removeChildMock).toHaveBeenCalledWith(mockTextarea);
    });

    it("handles special characters", async () => {
      const specialText = "Special chars: <>&\"'`\n\t";
      await copyToClipboard(specialText);

      expect(mockTextarea.value).toBe(specialText);
    });

    it("handles empty string", async () => {
      await copyToClipboard("");

      expect(mockTextarea.value).toBe("");
      expect(execCommandMock).toHaveBeenCalledWith("copy");
    });

    it("handles long text", async () => {
      const longText = "a".repeat(10000);
      await copyToClipboard(longText);

      expect(mockTextarea.value).toBe(longText);
    });
  });
});
