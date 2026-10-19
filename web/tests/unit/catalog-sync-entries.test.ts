import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/browser';
import { syncCatalogEntries } from '@/lib/catalog-sync/entries';

// Fields the sync does not take from the CSVs: the row key, editorial state,
// and timestamps the database owns.
const NOT_CSV_OWNED = new Set(['workflowGroupId', 'audioHash', 'isPublished', 'createdAt', 'updatedAt']);

const toColumn = (field: string) => field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

async function capturedUpdateSql(): Promise<string> {
  const executeRaw = vi.fn();
  const tx = {
    $executeRaw: executeRaw,
    catalogEntry: { deleteMany: vi.fn(), createMany: vi.fn() },
  } as unknown as Prisma.TransactionClient;
  await syncCatalogEntries(
    tx,
    '20260101_120000',
    [{ workflowGroupId: '20260101_120000', audioHash: 'a'.repeat(64), hasArchived: true, hasMetadata: true, isActionable: true }],
    new Date(),
  );
  expect(executeRaw).toHaveBeenCalledTimes(1);
  return (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
}

describe('syncCatalogEntries', () => {
  it('refreshes every CSV-owned catalog_entry column on existing rows', async () => {
    const sql = await capturedUpdateSql();
    const csvOwned = Object.values(Prisma.CatalogEntryScalarFieldEnum).filter(
      (field) => !NOT_CSV_OWNED.has(field),
    );

    // A column added to the model must also be added to the bulk UPDATE, or
    // existing rows would keep its first value forever.
    for (const field of csvOwned) {
      const recordsetName = field === field.toLowerCase() ? field : `"${field}"`;
      expect(sql, `${field} is missing from SET`).toContain(`${toColumn(field)} = source.${recordsetName}`);
      expect(sql, `${field} is missing from the recordset`).toMatch(
        new RegExp(`${recordsetName.replace(/"/g, '\\"')} [a-z]+`),
      );
    }
  });

  it('never writes publication state on existing rows', async () => {
    const sql = await capturedUpdateSql();
    expect(sql).not.toContain('is_published');
    expect(sql).not.toContain('created_at');
  });
});
