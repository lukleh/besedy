import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { toPrismaJson } from "@/lib/prisma-json";
import { getCurrentUserId } from "@/lib/auth/permissions";
import { createServerLogger } from "@/lib/log/server";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const logger = createServerLogger("client-error-report");

const MAX_BODY_SIZE = 64 * 1024; // 64KB
const MAX_MESSAGE_LENGTH = 4000;
const MAX_STACK_LENGTH = 16_000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const GLOBAL_RATE_LIMIT = 600;

function truncate(value: string | null | undefined, maxLength: number) {
  if (!value) return value ?? undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function getClientIp(request: NextRequest): string | null {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip")
  );
}

/**
 * POST /api/csp-report/client-error - Log client-side errors
 * This endpoint receives error reports from the client-side error boundary
 */
export async function POST(request: NextRequest) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  try {
    const rawBody = await request.text();
    if (getUtf8ByteLength(rawBody) > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Payload too large" }, { status: 413 });
    }
    let body: Record<string, unknown> | null = null;
    if (rawBody) {
      try {
        const parsed = JSON.parse(rawBody);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          logger.warn("Rejected non-object client error report payload");
          return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        body = parsed as Record<string, unknown>;
      } catch (error) {
        logger.warn("Rejected malformed client error report JSON", {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }
    // Global cap so a distributed burst can't flood client-error storage.
    // Per-client limiting already happens upstream in the proxy for all
    // /api/csp-report/* paths; this bounds the aggregate write rate across
    // clients. Checked after structural validation so malformed payloads
    // (rejected above) never consume the shared budget.
    if (!checkRateLimit("client-error:global", GLOBAL_RATE_LIMIT, RATE_LIMIT_WINDOW_MS)) {
      return NextResponse.json(
        { error: "Too many error reports" },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    const { message, stack, digest, url, userAgent, source, context } = body ?? {};
    const safeMessage = truncate(
      typeof message === "string" ? message : String(message ?? "Unknown error"),
      MAX_MESSAGE_LENGTH
    ) as string;
    const safeStack = truncate(typeof stack === "string" ? stack : undefined, MAX_STACK_LENGTH);
    const safeUserAgent =
      typeof userAgent === "string" ? userAgent : request.headers.get("user-agent") ?? undefined;
    const safeSource = truncate(
      typeof source === "string" ? source : undefined,
      50
    );
    const safeDigest = truncate(
      typeof digest === "string" ? digest : undefined,
      64
    );
    const safeUrl = typeof url === "string" ? url : undefined;
    const ipAddress = getClientIp(request);
    const userId = await getCurrentUserId();

    logger.error("Client error report", {
      message: safeMessage,
      digest: safeDigest,
      url: safeUrl,
      userAgent: safeUserAgent,
      source: safeSource,
      context,
      stack: safeStack?.split("\n").slice(0, 5).join("\n"), // First 5 lines of stack
      ipAddress,
      userId,
      timestamp: new Date().toISOString(),
    });

    try {
      await prisma.clientErrorReport.create({
        data: {
          userId,
          message: safeMessage,
          stack: safeStack,
          digest: safeDigest,
          source: safeSource,
          url: safeUrl,
          userAgent: safeUserAgent,
          ipAddress,
          context: toPrismaJson(context),
        },
      });
    } catch (error) {
      logger.error("Failed to store client error report", error);
    }

    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Failed to process error report" }, { status: 400 });
  }
}
