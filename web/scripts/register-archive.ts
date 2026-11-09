#!/usr/bin/env tsx
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      "archived-catalog-path": { type: "string" },
      "metadata-catalog-path": { type: "string" },
      "duplicates-catalog-path": { type: "string" },
      label: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run archive:register -- --archived-catalog-path <path> --metadata-catalog-path <path> [--duplicates-catalog-path <path>] [--label <label>]

DATABASE_URL must select the intended database; BESEDY_ARCHIVE_ID supplies the source ID.
Paths are those visible to the web container. Creates one source only; an existing ID is refused.
Run the archive preflight and catalog sync separately.`);
    return;
  }

  const [{ default: prisma }, { registerArchiveSource }] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/archive-registration"),
  ]);
  try {
    const source = await registerArchiveSource({
      archivedCatalogPath: values["archived-catalog-path"],
      metadataCatalogPath: values["metadata-catalog-path"],
      duplicatesCatalogPath: values["duplicates-catalog-path"],
      label: values.label,
    });
    console.log(JSON.stringify({ id: source.id, label: source.label }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
