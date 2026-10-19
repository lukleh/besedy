/**
 * Real PostgreSQL coverage for catalog projection/publication ownership.
 * Run against a migrated throwaway database with:
 * DATABASE_URL=... npm run test:catalog-sync-smoke
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  assert(connectionString, 'DATABASE_URL must name a migrated throwaway database');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'besedy-catalog-sync-'));
  const catalogId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
  const retainedHash = hash();
  const removedHash = hash();
  const addedHash = hash();
  const metadataPath = path.join(root, 'metadata.csv');
  const archivedPath = path.join(root, 'archived.csv');
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const publisher = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  let concurrentPublication: boolean | null = null;

  // Commit an editorial change on a separate connection at the point where
  // the old sync had already snapshotted publication and was about to delete
  // the rows. Extensions also run inside Prisma's interactive transactions.
  const syncClient = client.$extends({
    query: {
      catalogEntry: {
        async deleteMany({ args, query }) {
          if (concurrentPublication !== null && args.where?.workflowGroupId === catalogId) {
            const isPublished = concurrentPublication;
            concurrentPublication = null;
            await publisher.catalogEntry.update({
              where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: retainedHash } },
              data: { isPublished },
            });
          }
          return query(args);
        },
      },
    },
  });
  const shared = globalThis as unknown as { prisma: typeof syncClient | undefined };
  shared.prisma = syncClient;
  let createdCatalog = false;

  async function writeSources(hashes: string[], title: string, withAac: boolean) {
    await fs.writeFile(metadataPath, [
      'Hash,Hash Algorithm,Full Path,title',
      ...hashes.map((audioHash) => `${audioHash},pcm-s16le-16000hz-mono-sha256-v1,/audio/${audioHash}.wav,${title}`),
      '',
    ].join('\n'));
    await fs.writeFile(archivedPath, [
      'Hash,Compressed Path,Compressed AAC Path',
      ...hashes.map((audioHash) => `${audioHash},/audio/${audioHash}.webm,${withAac ? `/audio/${audioHash}.m4a` : ''}`),
      '',
    ].join('\n'));
  }

  try {
    const { syncCatalogGroup } = await import('@/lib/catalog-sync');
    await writeSources([retainedHash, removedHash], 'Old title', true);
    await client.workflowGroup.create({
      data: { id: catalogId, metadataCatalogPath: metadataPath, archivedCatalogPath: archivedPath },
    });
    createdCatalog = true;
    assert.equal((await syncCatalogGroup(catalogId)).status, 'success');
    const before = await client.catalogEntry.findUniqueOrThrow({
      where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: retainedHash } },
    });

    await writeSources([retainedHash, addedHash], 'Current title', false);
    for (const isPublished of [true, false]) {
      concurrentPublication = isPublished;
      const result = await syncCatalogGroup(catalogId, { force: true });
      assert.equal(result.status, 'success', result.error);
      assert.equal(concurrentPublication, null, 'the concurrent publication must have committed');
      const retained = await client.catalogEntry.findUniqueOrThrow({
        where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: retainedHash } },
      });
      assert.equal(retained.isPublished, isPublished, 'sync must preserve concurrent publish and unpublish');
      assert.equal(retained.createdAt.getTime(), before.createdAt.getTime(), 'retained rows must keep their identity');
      assert.equal(retained.sourceTitle, 'Current title');
      assert.equal(retained.compressedAacPath, null, 'blank source fields must clear previous values');
      assert.equal(retained.isActionable, true);
      assert.equal(retained.duplicateCount, 0);
      assert.equal((retained.sourceMetadataPayload as { title: string }).title, 'Current title');
    }
    const added = await client.catalogEntry.findUniqueOrThrow({
      where: { workflowGroupId_audioHash: { workflowGroupId: catalogId, audioHash: addedHash } },
    });
    assert.equal(added.isPublished, false, 'new recordings must start unpublished');
    assert.equal(await client.catalogEntry.count({ where: { workflowGroupId: catalogId, audioHash: removedHash } }), 0);

    // Clearing an explicitly allowed empty catalog still removes every row.
    await writeSources([], '', false);
    assert.equal((await syncCatalogGroup(catalogId, { allowRowCountDrop: true })).status, 'success');
    assert.equal(await client.catalogEntry.count({ where: { workflowGroupId: catalogId } }), 0);
    console.log('Catalog sync publication/concurrency checks passed');
  } finally {
    try {
      if (createdCatalog) await client.workflowGroup.delete({ where: { id: catalogId } });
    } finally {
      shared.prisma = undefined;
      await Promise.all([client.$disconnect(), publisher.$disconnect()]);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
