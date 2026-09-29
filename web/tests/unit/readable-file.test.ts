import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadableFile, openReadStream } from "@/lib/readable-file";

describe("checkReadableFile", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "besedy-readable-file-"));
    filePath = path.join(tmpDir, "file.bin");
    fs.writeFileSync(filePath, Buffer.alloc(16, 1));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts a readable regular file", async () => {
    const result = await checkReadableFile(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stat.size).toBe(16);
    }
  });

  it("rejects a directory as not a file", async () => {
    const result = await checkReadableFile(tmpDir);
    expect(result).toMatchObject({ ok: false, reason: "not_a_file", code: undefined });
  });

  it("reports a missing file with its errno code", async () => {
    const result = await checkReadableFile(path.join(tmpDir, "nope.bin"));
    expect(result).toMatchObject({ ok: false, reason: "missing", code: "ENOENT" });
  });

  it("reports a file under a missing directory component as missing", async () => {
    const result = await checkReadableFile(path.join(filePath, "child.bin"));
    expect(result).toMatchObject({ ok: false, reason: "missing", code: "ENOTDIR" });
  });

  it("reports an unreadable file with its errno code", async () => {
    fs.chmodSync(filePath, 0o000);
    const result = await checkReadableFile(filePath);
    fs.chmodSync(filePath, 0o644);
    if (process.getuid?.() === 0) {
      // root bypasses mode bits, so the check cannot fail here.
      expect(result.ok).toBe(true);
      return;
    }
    expect(result).toMatchObject({ ok: false, reason: "unreadable", code: "EACCES" });
  });
});

describe("openReadStream", () => {
  it("attaches listeners before an open error can fire", async () => {
    const missing = path.join(os.tmpdir(), `besedy-missing-${process.pid}-${Date.now()}.bin`);
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      openReadStream(missing, undefined, (stream) => stream.on("error", resolve));
    });
    expect(error.code).toBe("ENOENT");
  });

  it("passes range options through", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "besedy-readable-file-"));
    const filePath = path.join(tmpDir, "file.bin");
    fs.writeFileSync(filePath, Buffer.from("0123456789"));
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        openReadStream(filePath, { start: 2, end: 4 }, (stream) => {
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("end", resolve);
          stream.on("error", reject);
        });
      });
      expect(Buffer.concat(chunks).toString()).toBe("234");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
