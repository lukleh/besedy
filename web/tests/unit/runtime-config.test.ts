import { describe, it, expect } from "vitest";
import {
  getAuthTrustedOrigins,
  getRagBackendKey,
  getRagColbertModel,
  getRagRerankModel,
  getSupportEmail,
  getVapidSubject,
  RAG_DEFAULTS,
} from "@/lib/runtime-config";

describe("runtime config helpers", () => {
  it("builds trusted origins for development with deduplication", () => {
    const origins = getAuthTrustedOrigins(
      "development",
      "http://lan-host:3001",
      "http://tail1:3001,http://tail2:3001,http://tail1:3001",
      "http://localhost:3001,http://localhost:3009"
    );

    expect(origins).toEqual([
      "http://localhost:3001",
      "http://localhost:3009",
      "http://lan-host:3001",
      "http://tail1:3001",
      "http://tail2:3001",
    ]);
  });

  it("omits development localhost origins outside development mode", () => {
    const origins = getAuthTrustedOrigins(
      "production",
      "https://besedy.org",
      "https://admin.besedy.org",
      "http://localhost:3001"
    );

    expect(origins).toEqual([
      "https://besedy.org",
      "https://admin.besedy.org",
    ]);
  });

  it("uses configured VAPID subject when present", () => {
    expect(getVapidSubject("mailto:test@example.com")).toBe("mailto:test@example.com");
  });

  it("falls back to default VAPID subject", () => {
    expect(getVapidSubject("")).toBe("mailto:admin@example.com");
  });

  it("prefers plain support email over base64 value", () => {
    const email = getSupportEmail(
      "help@besedy.org",
      "ZmFsbGJhY2tAZXhhbXBsZS5jb20="
    );
    expect(email).toBe("help@besedy.org");
  });

  it("uses base64 support email when plain value is missing", () => {
    const email = getSupportEmail(undefined, "aGVscEBiZXNlZHkub3Jn");
    expect(email).toBe("help@besedy.org");
  });

  it("falls back to default ColBERT model", () => {
    expect(getRagColbertModel(undefined)).toBe(RAG_DEFAULTS.COLBERT_MODEL);
    expect(getRagColbertModel("custom/model")).toBe("custom/model");
  });

  it("uses the language-aware default RAG backend key", () => {
    expect(getRagBackendKey(undefined)).toBe(
      "faster-whisper/large-v3@silero_vad_v6@lang-auto"
    );
    expect(getRagBackendKey("faster-whisper/custom@lang-en")).toBe(
      "faster-whisper/custom@lang-en"
    );
  });

  it("falls back to default rerank model", () => {
    expect(getRagRerankModel(undefined)).toBe(RAG_DEFAULTS.RERANK_MODEL);
    expect(getRagRerankModel("custom/reranker")).toBe("custom/reranker");
  });
});
