import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const MAX_LOG_BYTES = 16_384;

type ReportBody = Record<string, unknown>;

function pickCspFields(body: ReportBody) {
  return {
    documentUri: body["document-uri"] ?? body["documentURL"] ?? body["documentUrl"],
    effectiveDirective: body["effective-directive"] ?? body["effectiveDirective"],
    violatedDirective: body["violated-directive"] ?? body["violatedDirective"],
    blockedUri: body["blocked-uri"] ?? body["blockedURL"] ?? body["blockedUri"],
    sourceFile: body["source-file"] ?? body["sourceFile"],
    lineNumber: body["line-number"] ?? body["lineNumber"],
    columnNumber: body["column-number"] ?? body["columnNumber"],
    disposition: body["disposition"],
    scriptSample: body["script-sample"] ?? body["scriptSample"],
  };
}

function normalizeReport(payload: unknown) {
  if (Array.isArray(payload)) {
    return payload.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const item = entry as Record<string, unknown>;
      const body = item.body;
      return {
        type: item.type,
        url: item.url,
        body:
          body && typeof body === "object"
            ? pickCspFields(body as ReportBody)
            : body,
      };
    });
  }

  if (payload && typeof payload === "object") {
    const item = payload as Record<string, unknown>;
    const legacyBody = item["csp-report"];
    if (legacyBody && typeof legacyBody === "object") {
      return { type: "csp-report", body: pickCspFields(legacyBody as ReportBody) };
    }
    return item;
  }

  return payload;
}

function truncate(value: string) {
  if (value.length <= MAX_LOG_BYTES) return value;
  return `${value.slice(0, MAX_LOG_BYTES)}...<truncated>`;
}

function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const MAX_BODY_SIZE = 10 * 1024; // 10KB - CSP reports are small

export async function POST(req: Request) {
  // Reject oversized payloads before reading body
  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  const contentType = req.headers.get("content-type") ?? "unknown";
  const userAgent = req.headers.get("user-agent") ?? "unknown";
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  let raw = "";
  try {
    raw = await req.text();
  } catch {
    raw = "";
  }

  if (getUtf8ByteLength(raw) > MAX_BODY_SIZE) {
    return new NextResponse("Payload too large", { status: 413 });
  }

  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  const report = parsed ? normalizeReport(parsed) : { raw: truncate(raw) };

  console.info("[csp-report]", {
    contentType,
    ip,
    userAgent,
    report,
  });

  return new NextResponse(null, { status: 204 });
}
