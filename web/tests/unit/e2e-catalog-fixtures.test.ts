import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Papa from "papaparse";
import { TEST_AUDIO_FILES } from "../../prisma/test-data";
import {
  TEST_HASH_ALGORITHM,
  generateArchivedCatalog,
  generateDuplicatesCatalog,
  generateMetadataCatalog,
} from "../e2e/scripts/generate-catalogs";
import catalogContract from "../../../contracts/catalog-csv.json";

let fixturesDir: string;

beforeEach(async () => {
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "besedy-e2e-catalogs-"));
});

afterEach(async () => {
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

describe("E2E catalog fixtures", () => {
  it.each([
    ["metadata", generateMetadataCatalog],
    ["archived", generateArchivedCatalog],
    ["duplicates", generateDuplicatesCatalog],
  ] as const)("writes current %s headers and required cells", async (kind, generate) => {
    const csv = await fs.readFile(await generate(fixturesDir), "utf-8");
    const { data, meta, errors } = Papa.parse<Record<string, string>>(csv, {
      header: true,
      skipEmptyLines: true,
    });
    const requirements = catalogContract.validation[kind];
    expect(errors).toEqual([]);
    expect(meta.fields).toEqual(expect.arrayContaining(requirements.requiredHeaders));
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      for (const column of requirements.nonBlankCells) {
        expect(row[column]?.trim()).toBeTruthy();
      }
      expect(row.Duration).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(row.added_at).toBeTruthy();
    }
  });

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
