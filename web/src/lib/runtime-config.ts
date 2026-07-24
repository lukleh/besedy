const DEFAULT_AUTH_DEV_TRUSTED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
] as const;

const DEFAULT_VAPID_SUBJECT = "mailto:admin@example.com";
// Placeholder (info@example.com); set NEXT_PUBLIC_SUPPORT_EMAIL(_B64) for the real address.
const DEFAULT_SUPPORT_EMAIL_B64 = "aW5mb0BleGFtcGxlLmNvbQ==";

export const RAG_DEFAULTS = {
  RESULT_LIMIT: 50,
  MAX_LIMIT: 50,
  RERANK_TOP_N: 50,
  RELATIVE_SCORE_CUTOFF: 0,
  TIMEOUT_MS: 8000,
  BACKEND_KEY: "faster-whisper/large-v3@silero_vad_v6@lang-auto",
  RERANK_URL: "http://host.docker.internal:8191/rerank",
  RERANK_MODEL: "Alibaba-NLP/gte-multilingual-reranker-base",
  COLBERT_URL: "http://host.docker.internal:8192/query",
  COLBERT_TOP_K: 200,
  COLBERT_MODEL: "jinaai/jina-colbert-v2",
  COLBERT_ROOT_DIR: "/data/state/rag_colbert",
} as const;

function parseCommaSeparated(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function getDevTrustedOrigins(
  raw = process.env.AUTH_DEV_TRUSTED_ORIGINS
): string[] {
  const configured = parseCommaSeparated(raw);
  return configured.length > 0
    ? uniqueValues(configured)
    : [...DEFAULT_AUTH_DEV_TRUSTED_ORIGINS];
}

export function getAuthExtraOrigins(
  raw = process.env.AUTH_EXTRA_ORIGINS
): string[] {
  return uniqueValues(parseCommaSeparated(raw));
}

export function getAuthTrustedOrigins(
  appEnv = process.env.APP_ENV,
  authUrl = process.env.AUTH_URL,
  extraOriginsRaw = process.env.AUTH_EXTRA_ORIGINS,
  devTrustedOriginsRaw = process.env.AUTH_DEV_TRUSTED_ORIGINS
): string[] {
  const origins: string[] = [];

  if (appEnv === "development") {
    origins.push(...getDevTrustedOrigins(devTrustedOriginsRaw));
  }

  const normalizedAuthUrl = authUrl?.trim();
  if (normalizedAuthUrl) {
    origins.push(normalizedAuthUrl);
  }

  origins.push(...getAuthExtraOrigins(extraOriginsRaw));
  return uniqueValues(origins);
}

export function getVapidSubject(
  value = process.env.VAPID_SUBJECT
): string {
  const normalized = value?.trim();
  return normalized || DEFAULT_VAPID_SUBJECT;
}

export function getRagRerankModel(
  value = process.env.RAG_RERANK_MODEL
): string {
  const normalized = value?.trim();
  return normalized || RAG_DEFAULTS.RERANK_MODEL;
}

export function getRagBackendKey(
  value = process.env.RAG_BACKEND_KEY
): string {
  const normalized = value?.trim();
  return normalized || RAG_DEFAULTS.BACKEND_KEY;
}

export function getRagColbertModel(
  value = process.env.RAG_COLBERT_MODEL
): string {
  const normalized = value?.trim();
  return normalized || RAG_DEFAULTS.COLBERT_MODEL;
}

function decodeBase64(value: string): string {
  if (typeof atob === "function") {
    return atob(value);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf-8");
  }
  throw new Error("No base64 decoder available");
}

export function getSupportEmail(
  plain = process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  encoded = process.env.NEXT_PUBLIC_SUPPORT_EMAIL_B64
): string {
  const normalizedPlain = plain?.trim();
  if (normalizedPlain) {
    return normalizedPlain;
  }

  const encodedValue = encoded?.trim() || DEFAULT_SUPPORT_EMAIL_B64;
  try {
    return decodeBase64(encodedValue);
  } catch {
    return decodeBase64(DEFAULT_SUPPORT_EMAIL_B64);
  }
}
