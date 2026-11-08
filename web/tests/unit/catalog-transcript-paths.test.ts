import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import contract from "../../../contracts/catalog-transcript-paths.json";
import { getTranscriptsBaseDir, resolveTranscriptsPath } from "@/lib/paths";

vi.mock("@/lib/config", () => ({
  getBesedyConfig: () => ({ paths: { text_data_dir: "/data/text", transcripts_dir: "ignored" } }),
}));

describe("catalog transcript path contract", () => {
  it("uses the same fixed parent as the pipeline and worker", () => {
    expect(getTranscriptsBaseDir()).toBe(path.join("/data/text", contract.parent));
  });

  it.each(contract.generations)("resolves $catalogId without following a latest symlink", ({ catalogId, directory }) => {
    expect(resolveTranscriptsPath(catalogId)).toBe(path.join("/data/text", contract.parent, directory));
  });

  it.each(contract.invalidCatalogIds)("refuses an invalid generation ID %j", (id) => {
    expect(() => resolveTranscriptsPath(id)).toThrow();
  });
});
