import { NextRequest, NextResponse } from 'next/server';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { z } from 'zod';
import prisma from '@/lib/db';
import {
  badRequest,
  conflict,
  handlePrismaError,
  notFound,
  validateMutationSource,
  validateParams,
} from '@/lib/api';
import { requireAdminCapability } from '@/lib/access/require-admin';
import { validatePath } from '@/lib/security/path-validation';
import { CuidSchema } from '@/lib/validation/schemas';
import {
  getIngestChunkBytes,
  resolveIntakeChunkPath,
  resolveIntakeChunksDir,
} from '@/lib/ingest/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChunkParamSchema = z.object({
  intakeId: CuidSchema,
  index: z.coerce.number().int().min(0).max(1_000_000),
});

interface RouteParams {
  params: Promise<{ intakeId: string; index: string }>;
}

class ChunkTooLargeError extends Error {
  constructor() {
    super('Chunk too large');
    this.name = 'ChunkTooLargeError';
  }
}

async function writeBody(
  body: ReadableStream<Uint8Array>,
  filePath: string,
  limit: number,
): Promise<number> {
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        callback(new ChunkTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(body as unknown as NodeReadableStream<Uint8Array>),
    counter,
    createWriteStream(filePath, { flags: 'wx' }),
  );
  return received;
}

async function publishChunk(
  body: ReadableStream<Uint8Array>,
  chunkPath: string,
  limit: number,
): Promise<number> {
  const tempPath = path.join(
    /* turbopackIgnore: true */
    path.dirname(chunkPath),
    `.${path.basename(chunkPath)}.${randomUUID()}`,
  );
  try {
    const written = await writeBody(body, tempPath, limit);
    if (written === 0) return 0;
    try {
      await fs.link(tempPath, chunkPath);
      return written;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await fs.lstat(chunkPath);
      if (!existing.isFile() || existing.size <= 0 || existing.size > limit) {
        throw new Error('Existing upload chunk is invalid');
      }
      return existing.size;
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * PUT /api/admin/ingest/uploads/:intakeId/chunks/:index
 * Stores one sequential chunk (raw body) as an immutable part.
 *
 * The complete part is published with an atomic hard link before the database
 * counters advance. The next index therefore remains unavailable while this
 * request is writing, and a retry can finish a commit interrupted after the
 * part was published.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    await requireAdminCapability({ message: 'Unauthorized' });

    const paramsResult = validateParams(await params, ChunkParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId, index } = paramsResult.data;

    const intake = await prisma.recordingIntake.findUnique({
      where: { id: intakeId },
    });
    if (!intake) return notFound('intake');
    if (intake.status !== 'UPLOADING') {
      return conflict('Upload is no longer accepting chunks');
    }
    if (index !== intake.receivedChunks) {
      return NextResponse.json(
        {
          error: 'Unexpected chunk index',
          expectedIndex: intake.receivedChunks,
        },
        { status: 409 },
      );
    }

    const previousBytes = Number(intake.receivedBytes);
    const remaining = Number(intake.expectedSizeBytes) - previousBytes;
    if (remaining <= 0) {
      return conflict('Upload already has all bytes');
    }
    const limit = Math.min(getIngestChunkBytes(), remaining);
    const declaredLength = request.headers.get('content-length');
    if (declaredLength && parseInt(declaredLength, 10) > limit) {
      return NextResponse.json({ error: 'Chunk too large' }, { status: 413 });
    }
    if (!request.body) {
      return badRequest('Chunk body is required');
    }

    const chunksDir = resolveIntakeChunksDir(intake);
    const chunksValidation = validatePath(chunksDir);
    if (!chunksValidation.valid) {
      return NextResponse.json(
        { error: 'Invalid upload chunks path' },
        { status: 500 },
      );
    }

    let written: number;
    try {
      written = await publishChunk(
        request.body,
        resolveIntakeChunkPath(intake, index),
        limit,
      );
    } catch (error) {
      if (error instanceof ChunkTooLargeError) {
        return NextResponse.json({ error: 'Chunk too large' }, { status: 413 });
      }
      throw error;
    }
    if (written === 0) {
      return badRequest('Chunk body is empty');
    }

    const committed = await prisma.recordingIntake.updateMany({
      where: {
        id: intake.id,
        status: 'UPLOADING',
        receivedChunks: index,
        receivedBytes: BigInt(previousBytes),
      },
      data: {
        receivedChunks: { increment: 1 },
        receivedBytes: { increment: BigInt(written) },
      },
    });
    if (committed.count !== 1) {
      const fresh = await prisma.recordingIntake.findUnique({
        where: { id: intake.id },
      });
      return NextResponse.json(
        {
          error: 'Unexpected chunk index',
          expectedIndex: fresh?.receivedChunks ?? index,
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      intakeId: intake.id,
      receivedBytes: previousBytes + written,
      receivedChunks: index + 1,
    });
  } catch (error) {
    return handlePrismaError(error, 'recording ingest chunk', 'create');
  }
}
