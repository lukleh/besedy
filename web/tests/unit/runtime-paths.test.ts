import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getBesedyConfigSearchPaths,
  getWebEnvSearchPaths,
  resolveBesedyConfigHome,
  resolveBesedyStateHome,
} from "@/lib/runtime-paths";

const originalEnv = process.env;

describe("runtime-paths", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("resolves the preferred config home from HOME by default", () => {
    process.env.HOME = "/mock/home";
    delete process.env.XDG_CONFIG_HOME;

    expect(resolveBesedyConfigHome("/repo")).toBe("/mock/home/.config/lukleh/besedy");
  });

  it("resolves the state home from XDG_STATE_HOME", () => {
    process.env.XDG_STATE_HOME = "/mock/state";
    delete process.env.BESEDY_STATE_HOME;

    expect(resolveBesedyStateHome("/repo")).toBe("/mock/state/lukleh/besedy");
  });

  it("builds config search paths from explicit override and canonical home path only", () => {
    process.env.HOME = "/mock/home";
    process.env.BESEDY_CONFIG = "/explicit/besedy.toml";

    expect(getBesedyConfigSearchPaths("/repo")).toEqual(["/explicit/besedy.toml"]);
  });

  it("builds test env search paths from the explicit override only", () => {
    process.env.HOME = "/mock/home";
    process.env.BESEDY_WEB_ENV_TEST = "/explicit/web.env.test";

    expect(getWebEnvSearchPaths("test", "/repo/web")).toEqual(["/explicit/web.env.test"]);
  });

  it("builds test env search paths from the canonical home path by default", () => {
    process.env.HOME = "/mock/home";
    delete process.env.BESEDY_WEB_ENV_TEST;

    expect(getWebEnvSearchPaths("test", "/repo/web")).toEqual([
      "/mock/home/.config/lukleh/besedy/web.env.test",
    ]);
  });
});
