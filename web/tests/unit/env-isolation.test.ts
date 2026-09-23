import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RUNTIME_ENV_VARS, webEnvVarNames } from "../env-isolation";

const webDir = path.join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("unit test env isolation", () => {
  it("clears every variable the web app reads by name", () => {
    const read = new Set<string>();
    for (const file of sourceFiles(path.join(webDir, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const [, dot, bracket] of text.matchAll(
        /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
      )) {
        read.add(dot ?? bracket);
      }
    }
    const covered = webEnvVarNames(webDir);
    const uncovered = [...read].filter(
      (name) => !covered.has(name) && !RUNTIME_ENV_VARS.includes(name),
    );

    // Add new variables to a web env template or to EXTRA_WEB_ENV_VARS.
    expect(uncovered.sort()).toEqual([]);
  });
});
