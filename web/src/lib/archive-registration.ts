import prisma from "@/lib/db";
import { requireArchiveId } from "@/lib/archive";
import { UpdateCatalogSchema } from "@/lib/validation/schemas";

const ArchiveRegistrationSchema = UpdateCatalogSchema.required({
  archivedCatalogPath: true,
  metadataCatalogPath: true,
});

/** Operator-only bootstrap: never rewrite an existing source or grant access. */
export async function registerArchiveSource(input: unknown) {
  const id = requireArchiveId();
  const data = ArchiveRegistrationSchema.parse(input);
  return prisma.workflowGroup.create({ data: { id, ...data } });
}
