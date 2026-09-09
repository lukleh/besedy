import { NextRequest, NextResponse } from "next/server";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeReadableStream } from "stream/web";
import { z } from "zod";
import prisma from "@/lib/db";
import {
  badRequest,
  conflict,
  handlePrismaError,
  notFound,
  validateMutationSource,
  validateParams,
} from "@/lib/api";
import { requireAdminCapability } from "@/lib/access/require-admin";
import { validatePath } from "@/lib/security/path-validation";
import { CuidSchema } from "@/lib/validation/schemas";
import { getIngestChunkBytes, resolveIntakeFilePath } from "@/lib/ingest/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ChunkParamSchema = z.object({
  intakeId: CuidSchema,
  index: z.coerce.number().int().min(0).max(1_000_000),
});

interface RouteParams {
  params: Promise<{ intakeId: string; index: string }>;
}

class ChunkTooLargeError extends Error {
  constructor() {
    super("Chunk too large");
    this.name = "ChunkTooLargeError";
  }
}

async function appendBody(
  body: ReadableStream<Uint8Array>,
  filePath: string,
  limit: number
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
    createWriteStream(filePath, { flags: "a" })
  );
  return received;
}

/**
 * PUT /api/admin/ingest/uploads/:intakeId/chunks/:index
 * Appends one sequential chunk (raw body) to the upload.
 *
 * The chunk slot is claimed in the database before any bytes are written, so a
 * concurrent or duplicate request for the same index is rejected up front and
 * can never interleave with, or roll back, a write it did not make.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const sourceError = validateMutationSource(request);
    if (sourceError) return sourceError;

    await requireAdminCapability({ message: "Unauthorized" });

    const paramsResult = validateParams(await params, ChunkParamSchema);
    if (!paramsResult.success) return paramsResult.response;
    const { intakeId, index } = paramsResult.data;

    const intake = await prisma.recordingIntake.findUnique({ where: { id: intakeId } });
    if (!intake) return notFound("intake");
    if (intake.status !== "UPLOADING") {
      return conflict("Upload is no longer accepting chunks");
    }
    if (index !== intake.receivedChunks) {
      return NextResponse.json(
        { error: "Unexpected chunk index", expectedIndex: intake.receivedChunks },
        { status: 409 }
      );
    }

    const previousBytes = Number(intake.receivedBytes);
    const remaining = Number(intake.expectedSizeBytes) - previousBytes;
    if (remaining <= 0) {
      return conflict("Upload already has all bytes");
    }
    const limit = Math.min(getIngestChunkBytes(), remaining);
    const declaredLength = request.headers.get("content-length");
    if (declaredLength && parseInt(declaredLength, 10) > limit) {
      return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
    }
    if (!request.body) {
      return badRequest("Chunk body is required");
    }

    const filePath = resolveIntakeFilePath(intake);
    const fileValidation = validatePath(filePath);
    if (!fileValidation.valid) {
      return NextResponse.json({ error: "Invalid upload file path" }, { status: 500 });
    }

    const claimed = await prisma.recordingIntake.updateMany({
      where: { id: intake.id, status: "UPLOADING", receivedChunks: index },
      data: { receivedChunks: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      return NextResponse.json(
        { error: "Unexpected chunk index", expectedIndex: index + 1 },
        { status: 409 }
      );
    }

    const releaseClaim = async () => {
      await fs.truncate(fileValidation.resolvedPath, previousBytes).catch(() => undefined);
      await prisma.recordingIntake.updateMany({
        where: { id: intake.id, receivedChunks: index + 1 },
        data: { receivedChunks: index },
      });
    };

    let written: number;
    try {
      written = await appendBody(request.body, fileValidation.resolvedPath, limit);
    } catch (error) {
      await releaseClaim();
      if (error instanceof ChunkTooLargeError) {
        return NextResponse.json({ error: "Chunk too large" }, { status: 413 });
      }
      throw error;
    }
    if (written === 0) {
      await releaseClaim();
      return badRequest("Chunk body is empty");
    }

    await prisma.recordingIntake.update({
      where: { id: intake.id },
      data: { receivedBytes: { increment: BigInt(written) } },
    });

    return NextResponse.json({
      intakeId: intake.id,
      receivedBytes: previousBytes + written,
      receivedChunks: index + 1,
    });
  } catch (error) {
    return handlePrismaError(error, "recording ingest chunk", "create");
  }
}
