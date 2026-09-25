import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";

const TEXT_DATA_DIR = "/data/text";

vi.mock("@/lib/runtime-paths", () => ({
  getBesedyConfigSearchPaths: () => ["/nonexistent/besedy.toml"],
}));

describe("corrections directory resolution", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  async function resolveWith(correctionsDir?: string): Promise<string> {
    vi.doMock("@iarna/toml", () => ({
      parse: () => ({
        paths: {
          text_data_dir: TEXT_DATA_DIR,
          transcripts_dir: "transcripts",
          ...(correctionsDir === undefined ? {} : { corrections_dir: correctionsDir }),
        },
      }),
    }));
    vi.doMock("fs", () => ({
      default: { existsSync: () => true, readFileSync: () => "" },
      existsSync: () => true,
      readFileSync: () => "",
    }));
    const { getCorrectionsDir } = await import("@/lib/config");
    return getCorrectionsDir();
  }

  it("defaults to a directory under the text data root", async () => {
    await expect(resolveWith()).resolves.toBe(path.join(TEXT_DATA_DIR, "corrections"));
  });

  it("uses an absolute value as given", async () => {
    await expect(resolveWith("/mnt/corrections")).resolves.toBe("/mnt/corrections");
  });

  // The Python resolver reads a relative value as relative to text_data_dir.
  // Reading it relative to the web process working directory instead would put
  // publication and indexing in different trees, and corrected text would
  // simply never reach search.
  // One case per test: the config is cached per module registry, and
  // resetModules only runs between tests.
  it("resolves a relative value against the text data root, as Python does", async () => {
    await expect(resolveWith("corrections")).resolves.toBe(
      path.join(TEXT_DATA_DIR, "corrections")
    );
  });

  it("resolves a nested relative value the same way", async () => {
    await expect(resolveWith("shared/corrections")).resolves.toBe(
      path.join(TEXT_DATA_DIR, "shared/corrections")
    );
  });

  it("expands a leading tilde, as Python does", async () => {
    await expect(resolveWith("~/corr")).resolves.toBe(path.join(os.homedir(), "corr"));
  });
});
