import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "../scripts/resolve_web_version.sh");

describe("resolve_web_version.sh", () => {
  let repo: string;

  function write(path: string, contents: string) {
    const absolutePath = resolve(repo, path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), "besedy-web-version-"));
    git("init", "-q");
    git("config", "user.name", "Besedy Test");
    git("config", "user.email", "test@besedy.invalid");

    write("web/src/app.ts", "export const value = 1;\n");
    write("web/public/sw.js", "self.addEventListener('install', () => {});\n");
    write("web/messages/en.json", "{}\n");
    write("web/package.json", "{}\n");
    write("web/package-lock.json", "{}\n");
    write("web/next.config.ts", "export default {};\n");
    write("web/tsconfig.json", "{}\n");
    write("web/postcss.config.mjs", "export default {};\n");
    write("web/prisma.config.ts", "export default {};\n");
    write("web/prisma/schema.prisma", "datasource db { provider = \"postgresql\" }\n");
    write("web/Dockerfile", "FROM scratch\n");
    write("web/docker-compose.yml", "services: {}\n");
    write("web/.dockerignore", "tests\n");
    write("web/tests/unit/example.test.ts", "test('example', () => {});\n");
    write("web/README.md", "web docs\n");
    write("scripts/resolve_web_version.sh", "# tracked fingerprint input\n");
    write("README.md", "root docs\n");
    git("add", ".");
    git("commit", "-qm", "initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  }

  function commit(path: string, contents: string, message: string) {
    write(path, contents);
    git("add", path);
    git("commit", "-qm", message);
  }

  function resolveVersion(env: Record<string, string> = {}) {
    return spawnSync("bash", [script, repo], {
      encoding: "utf8",
      env: {
        ...process.env,
        APP_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://besedy.example",
        VAPID_PUBLIC_KEY: "public-vapid-a",
        NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.test",
        NEXT_PUBLIC_SUPPORT_EMAIL_B64: "",
        OAUTH_MOCK_URL: "",
        ...env,
      },
    });
  }

  it("changes for production inputs but not tests, docs, or unrelated code", () => {
    const initial = resolveVersion();
    expect(initial.status).toBe(0);
    expect(initial.stdout.trim()).toMatch(/^web-v2-[a-f0-9]{40}$/);

    commit("README.md", "unrelated root change\n", "root docs");
    expect(resolveVersion().stdout).toBe(initial.stdout);

    commit("web/tests/unit/example.test.ts", "test('changed', () => {});\n", "test only");
    expect(resolveVersion().stdout).toBe(initial.stdout);

    commit("web/README.md", "changed web docs\n", "web docs only");
    expect(resolveVersion().stdout).toBe(initial.stdout);

    commit("web/src/app.ts", "export const value = 2;\n", "production source");
    expect(resolveVersion().stdout).not.toBe(initial.stdout);
  });

  it("includes public build configuration but never secret configuration", () => {
    const initial = resolveVersion();

    expect(resolveVersion({ NEXT_PUBLIC_APP_URL: "https://new.example" }).stdout).not.toBe(
      initial.stdout
    );
    expect(resolveVersion({ VAPID_PUBLIC_KEY: "public-vapid-b" }).stdout).not.toBe(
      initial.stdout
    );
    expect(resolveVersion({ AUTH_SECRET: "secret-a" }).stdout).toBe(
      resolveVersion({ AUTH_SECRET: "secret-b" }).stdout
    );
  });

  it("changes when the fingerprint algorithm itself changes", () => {
    const initial = resolveVersion();

    commit("scripts/resolve_web_version.sh", "# fingerprint input v2\n", "version algorithm");

    expect(resolveVersion().stdout).not.toBe(initial.stdout);
  });

  it("refuses all dirty web sources, including excluded tests", () => {
    write("web/tests/unit/example.test.ts", "dirty test\n");

    const result = resolveVersion();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dirty web sources");
  });
});
