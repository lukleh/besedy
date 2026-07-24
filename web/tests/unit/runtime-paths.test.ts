import { describe, expect, it, vi } from "vitest";
import {
  getBesedyConfigSearchPaths,
  getWebEnvSearchPaths,
  resolveBesedyConfigHome,
  resolveBesedyStateHome,
} from "@/lib/runtime-paths";

describe("runtime-paths", () => {
  it("resolves the preferred config home from HOME by default", () => {
    vi.stubEnv("HOME", "/mock/home");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);

    expect(resolveBesedyConfigHome("/repo")).toBe("/mock/home/.config/lukleh/besedy");
  });

  it("resolves the state home from XDG_STATE_HOME", () => {
    vi.stubEnv("XDG_STATE_HOME", "/mock/state");
    vi.stubEnv("BESEDY_STATE_HOME", undefined);

    expect(resolveBesedyStateHome("/repo")).toBe("/mock/state/lukleh/besedy");
  });

  it("builds config search paths from explicit override and canonical home path only", () => {
    vi.stubEnv("HOME", "/mock/home");
    vi.stubEnv("BESEDY_CONFIG", "/explicit/besedy.toml");

    expect(getBesedyConfigSearchPaths("/repo")).toEqual(["/explicit/besedy.toml"]);
  });

  it("builds test env search paths from the explicit override only", () => {
    vi.stubEnv("HOME", "/mock/home");
    vi.stubEnv("BESEDY_WEB_ENV_TEST", "/explicit/web.env.test");

    expect(getWebEnvSearchPaths("test", "/repo/web")).toEqual(["/explicit/web.env.test"]);
  });

  it("builds test env search paths from the canonical home path by default", () => {
    vi.stubEnv("HOME", "/mock/home");
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    vi.stubEnv("BESEDY_WEB_ENV_TEST", undefined);

    expect(getWebEnvSearchPaths("test", "/repo/web")).toEqual([
      "/mock/home/.config/lukleh/besedy/web.env.test",
    ]);
  });
});
