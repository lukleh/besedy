import prisma from "@/lib/db";

/**
 * Display names for actor keys.
 *
 * Correctors are not anonymous to one another: this group resolves
 * disagreement by talking, which needs names rather than opaque ids. A
 * deleted account keeps its place in the history and simply has no name. A
 * name is the display name, or the part of the address before the @ when the
 * account never set one; never the full address, which every corrector would
 * see.
 */
export async function loadActorNames(actorKeys: readonly string[]): Promise<Map<string, string | null>> {
  const keys = [...new Set(actorKeys)];
  if (keys.length === 0) return new Map();

  const actors = await prisma.user.findMany({
    where: { id: { in: keys } },
    select: { id: true, name: true, email: true },
  });

  return new Map(actors.map((actor) => [actor.id, actor.name ?? actor.email?.split("@")[0] ?? null]));
}
