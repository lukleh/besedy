import { readFileSync } from "node:fs";
import path from "node:path";

/** Env templates whose variables configure the web app. */
export const WEB_ENV_TEMPLATES = [
  ".env.example",
  ".env.dev.example",
  ".env.test.example",
  ".env.prod.example",
];

/**
 * Variables the web app reads that no template lists, including names built
 * at runtime (runtime-paths.ts) that a static scan of src cannot see.
 */
export const EXTRA_WEB_ENV_VARS = [
  "AUTH_REDESIGN_METRICS_ENABLED",
  "AUTH_REDESIGN_METRICS_WINDOW_SECONDS",
  "AUTH_REDESIGN_REASON_LOG_LEVEL",
  "BESEDY_CACHE_HOME",
  "BESEDY_MCP_JWKS_URL",
  "BESEDY_MCP_TEST_ENABLED",
  "BESEDY_STATE_HOME",
  "BESEDY_WEB_ENV_DEV",
  "BESEDY_WEB_ENV_PROD",
  "BESEDY_WEB_ENV_TEST",
  "BETTER_AUTH_SECRET",
  "BUILD_TIME",
  "CATALOG_SYNC_ALLOW_ROW_COUNT_DROP",
  "GIT_COMMIT",
  "JOBS_API_BASE_URL",
  "NEXT_PUBLIC_APP_ENV",
  "NEXT_PUBLIC_WEB_VERSION",
  "RAG_COLBERT_INDEX_DIR",
  "RAG_RERANK_URL",
  "WEB_VERSION",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
];

/** Owned by the test runtime itself; never cleared. */
export const RUNTIME_ENV_VARS = ["HOME", "NEXT_RUNTIME", "NODE_ENV"];

/** Every variable the unit test setup clears before test modules load. */
export function webEnvVarNames(webDir: string): Set<string> {
  const names = new Set(EXTRA_WEB_ENV_VARS);
  for (const template of WEB_ENV_TEMPLATES) {
    const text = readFileSync(path.join(webDir, template), "utf8");
    for (const [, name] of text.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)) {
      names.add(name);
    }
  }
  return names;
}
