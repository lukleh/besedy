#!/usr/bin/env tsx
import prisma from '../src/lib/db';
import { inspectArchiveMigration } from '../src/lib/archive-preflight';

async function main() {
  try {
    const report = await inspectArchiveMigration();
    console.log(JSON.stringify(report, null, 2));
    if (report.blockers.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
