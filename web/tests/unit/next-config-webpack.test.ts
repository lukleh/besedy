import { afterEach, describe, expect, it, vi } from "vitest";

type WebpackConfig = {
  context?: string;
  resolve?: { alias?: Record<string, unknown> };
  plugins?: unknown[];
};

const stubPath = `${process.cwd()}/src/lib/catalog-sync-startup.stub.ts`;

async function runWebpackHook(nextRuntime: "edge" | "nodejs" | undefined) {
  vi.resetModules();
  const { default: nextConfig } = await import("../../next.config");
  // next-intl's wrapper resolves its request config relative to the context.
  const config: WebpackConfig = { context: process.cwd(), resolve: { alias: {} }, plugins: [] };
  const webpack = { NormalModuleReplacementPlugin: class {} };
  const hook = nextConfig.webpack as (config: WebpackConfig, options: unknown) => WebpackConfig;
  return hook(config, { webpack, nextRuntime, dev: true, isServer: nextRuntime !== undefined });
}

function stubbedKeys(config: WebpackConfig) {
  return Object.entries(config.resolve?.alias ?? {})
    .filter(([, target]) => target === stubPath)
    .map(([key]) => key);
}

describe("next.config development webpack aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("swaps catalog-sync-startup for the stub in the edge compile", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const config = await runWebpackHook("edge");
    expect(stubbedKeys(config)).toEqual(
      expect.arrayContaining([
        "@/lib/catalog-sync-startup$",
        `${process.cwd()}/src/lib/catalog-sync-startup$`,
      ]),
    );
  });

  it("keeps the real module in the Node.js server compile used by /api/health", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const config = await runWebpackHook("nodejs");
    expect(stubbedKeys(config)).toEqual([]);
  });

  it("keeps the real module in the client compile", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const config = await runWebpackHook(undefined);
    expect(stubbedKeys(config)).toEqual([]);
  });

  it("does not alias anything outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const config = await runWebpackHook("edge");
    expect(stubbedKeys(config)).toEqual([]);
  });
});
