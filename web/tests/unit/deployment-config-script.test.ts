import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(process.cwd(), "../scripts/validate_web_config_mount.sh");

describe("validate_web_config_mount.sh", () => {
  let testRoot: string;
  let configHome: string;

  beforeEach(() => {
    testRoot = mkdtempSync(resolve(tmpdir(), "besedy-config-mount-"));
    configHome = resolve(testRoot, "config", "lukleh", "besedy");
    mkdirSync(configHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  function validate(configFile: string, overrides: string[] = []) {
    writeFileSync(
      resolve(configHome, "web.env.prod"),
      [
        `CONFIG_FILE=${configFile}`,
        "CONFIG_MOUNT=/data/config/besedy.toml",
        "BESEDY_CONFIG=/data/config/besedy.toml",
        ...overrides,
        "",
      ].join("\n")
    );

    return spawnSync("bash", [script, "production"], {
      encoding: "utf8",
      env: {
        ...process.env,
        BESEDY_WEB_ENV_PROD: "",
        XDG_CONFIG_HOME: resolve(testRoot, "config"),
      },
    });
  }

  it("accepts an absolute, container-readable regular file", () => {
    const configFile = resolve(testRoot, "besedy.container.toml");
    writeFileSync(configFile, "[paths]\ntext_data_dir = \"/data/text\"\n");
    chmodSync(configFile, 0o644);

    const result = validate(configFile);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Validated production web config mount");
  });

  it("rejects a relative production config path", () => {
    const result = validate("./besedy.container.toml");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CONFIG_FILE must be an absolute host path");
  });

  it("rejects a missing bind source before Docker can create a directory", () => {
    const configFile = resolve(testRoot, "missing-besedy.container.toml");

    const result = validate(configFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker would create a directory at a missing bind source");
  });

  it("rejects a production config stored inside the checkout", () => {
    const result = validate(resolve(process.cwd(), "besedy.container.toml.example"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CONFIG_FILE must live outside the checkout");
  });

  it("rejects a directory before Docker can bind-mount it", () => {
    const configDirectory = resolve(testRoot, "besedy.container.toml");
    mkdirSync(configDirectory);

    const result = validate(configDirectory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CONFIG_FILE is not a regular file");
  });

  it("rejects a file the production container user cannot read", () => {
    const configFile = resolve(testRoot, "besedy.container.toml");
    writeFileSync(configFile, "[paths]\ntext_data_dir = \"/data/text\"\n");
    chmodSync(configFile, 0o640);

    const result = validate(configFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be readable by the container's unprivileged user");
  });

  it("rejects a runtime path that differs from the mount target", () => {
    const configFile = resolve(testRoot, "besedy.container.toml");
    writeFileSync(configFile, "[paths]\ntext_data_dir = \"/data/text\"\n");
    chmodSync(configFile, 0o644);

    const result = validate(configFile, ["BESEDY_CONFIG=/data/config/other.toml"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BESEDY_CONFIG (/data/config/other.toml) must match CONFIG_MOUNT");
  });
});
