import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ default: {} }));

import {
  AUDIO_HASH_ALGORITHM,
  countUnrecognizedHashAlgorithms,
  toArchivedPayload,
  toDuplicatePayload,
  toMetadataPayload,
} from "@/lib/catalog-sync";

// The same file tests/test_catalog_csv_contract.py checks the Python writers
// against, so the two sides cannot drift apart silently.
const contract = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../contracts/catalog-csv.json"), "utf-8"),
) as {
  hashAlgorithm: string;
  metadata: string[];
  archived: string[];
  duplicates: string[];
};

type Row = Record<string, string>;

/** A row holding every contract column with its own name as the value. */
function rowOf(columns: string[]): Row {
  return Object.fromEntries(columns.map((column) => [column, column]));
}

/** The columns a payload mapper reads: each payload value is the column it came from. */
function columnsRead(payload: object): string[] {
  return Object.values(payload)
    .filter((value): value is string => typeof value === "string")
    .sort();
}

describe("catalog CSV contract", () => {
  it("uses the hash algorithm Python writes", () => {
    expect(AUDIO_HASH_ALGORITHM).toBe(contract.hashAlgorithm);
  });

  it("reads exactly the metadata columns of the contract", () => {
    // Hash and Hash Algorithm are read outside the payload.
    const keys = ["Hash", "Hash Algorithm"];
    const row = rowOf(contract.metadata);
    expect([...columnsRead(toMetadataPayload(row)), ...keys].sort()).toEqual(
      [...contract.metadata].sort(),
    );
  });

  it("reads exactly the archived columns of the contract", () => {
    const row = rowOf(contract.archived);
    expect([...columnsRead(toArchivedPayload(row)), "Hash"].sort()).toEqual(
      [...contract.archived].sort(),
    );
  });

  it("reads exactly the duplicates columns of the contract", () => {
    const row = rowOf(contract.duplicates);
    expect(columnsRead(toDuplicatePayload(row))).toEqual([...contract.duplicates].sort());
  });
});

describe("countUnrecognizedHashAlgorithms", () => {
  const hash = "a".repeat(64);

  it("counts rows whose algorithm is missing or not the contract's", () => {
    const rows: Row[] = [
      { Hash: hash, "Hash Algorithm": AUDIO_HASH_ALGORITHM },
      { Hash: hash, "Hash Algorithm": ` ${AUDIO_HASH_ALGORITHM} ` },
      { Hash: hash, "Hash Algorithm": "sha256-of-file" },
      { Hash: hash, "Hash Algorithm": "" },
      { Hash: hash },
    ];
    expect(countUnrecognizedHashAlgorithms(rows)).toBe(3);
  });

  it("ignores rows without a hash", () => {
    expect(countUnrecognizedHashAlgorithms([{ Hash: "", "Hash Algorithm": "other" }])).toBe(0);
    expect(countUnrecognizedHashAlgorithms([])).toBe(0);
  });
});
