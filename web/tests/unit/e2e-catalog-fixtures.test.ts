import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Papa from "papaparse";
import { TEST_AUDIO_FILES } from "../../prisma/test-data";
import { TEST_HASH_ALGORITHM, generateMetadataCatalog } from "../e2e/scripts/generate-catalogs";

let fixturesDir: string;

beforeEach(async () => {
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-e2e-catalogs-"));
});

afterEach(async () => {
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

describe("E2E catalog fixtures", () => {
  it("writes the typed hash contract the CLI requires into the metadata catalog", async () => {
    const csv = await fs.readFile(await generateMetadataCatalog(fixturesDir), "utf-8");
    const { data, meta } = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });

    expect(TEST_HASH_ALGORITHM).toBe("pcm-s16le-16000hz-mono-sha256-v1");
    expect(meta.fields).toContain("Hash Algorithm");
    expect(data).toHaveLength(TEST_AUDIO_FILES.length);
    for (const row of data) {
      expect(row["Hash Algorithm"]).toBe(TEST_HASH_ALGORITHM);
    }
  });
});
