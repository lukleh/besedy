import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";

// Mock fs module
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe("getSuperadminEmail", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("should return null when web section is not configured", async () => {
    // Set env so config can be found
    vi.stubEnv("BESEDY_CONFIG", "/mock/besedy.toml");

    // Mock fs
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      `[paths]\ntext_data_dir = "/data"\ntranscripts_dir = "transcripts"`
    );

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBeNull();
  });

  it("should return null when superadmin_email is empty string", async () => {
    vi.stubEnv("BESEDY_CONFIG", "/mock/besedy.toml");

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
superadmin_email = ""
`);

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBeNull();
  });

  it("should return lowercase trimmed email when configured", async () => {
    vi.stubEnv("BESEDY_CONFIG", "/mock/besedy.toml");

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
superadmin_email = " Admin@Example.COM "
`);

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBe("admin@example.com");
  });

  it("should return email as-is when already lowercase", async () => {
    vi.stubEnv("BESEDY_CONFIG", "/mock/besedy.toml");

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
superadmin_email = "user@example.org"
`);

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBe("user@example.org");
  });

  it("should fall back to the preferred home config path", async () => {
    vi.stubEnv("BESEDY_CONFIG", undefined);
    vi.stubEnv("HOME", "/mock/home");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);

    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) => candidate === "/mock/home/.config/lukleh/besedy/besedy.toml"
    );
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
superadmin_email = "home@example.org"
`);

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBe("home@example.org");
  });

  it("should honor XDG_CONFIG_HOME for home config discovery", async () => {
    vi.stubEnv("BESEDY_CONFIG", undefined);
    vi.stubEnv("XDG_CONFIG_HOME", "/mock/config-home");

    vi.mocked(fs.existsSync).mockImplementation(
      (candidate) =>
        candidate === "/mock/config-home/lukleh/besedy/besedy.toml"
    );
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
superadmin_email = "override@example.org"
`);

    const { getSuperadminEmail, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    const result = getSuperadminEmail();
    expect(result).toBe("override@example.org");
  });
});

describe("getDeepSearchDefaultInstructions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BESEDY_CONFIG", "/mock/besedy.toml");
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  it("returns the configured deep-search instructions", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"

[web]
deep_search_default_instructions = " Write a configured report. "
`);

    const { getDeepSearchDefaultInstructions, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    expect(getDeepSearchDefaultInstructions()).toBe("Write a configured report.");
  });

  it("throws when the deep-search instructions is not configured", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
[paths]
text_data_dir = "/data"
transcripts_dir = "transcripts"
`);

    const { getDeepSearchDefaultInstructions, clearConfigCache } = await import(
      "@/lib/config"
    );
    clearConfigCache();

    expect(() => getDeepSearchDefaultInstructions()).toThrow(
      /web\.deep_search_default_instructions is required/
    );
  });
});
