import path from "node:path";
import { z } from "zod";
import { Prisma, type AccessLevel } from "@/generated/prisma/client";
import { requiresReadyRecordingScope } from "@/lib/policy/recording";
import {
  getRagBackendKey,
  getRagColbertModel,
  getRagRerankModel,
  RAG_DEFAULTS,
} from "@/lib/runtime-config";

const DEFAULT_RESULT_LIMIT = RAG_DEFAULTS.RESULT_LIMIT;
const MAX_LIMIT = RAG_DEFAULTS.MAX_LIMIT;
const MAX_CANDIDATE_LIMIT = 200;
const MAX_NEIGHBOR_COUNT = 3;
const MAX_PER_AUDIO_LIMIT = 20;
const MAX_METADATA_FILTER_VALUES = 50;
const DEFAULT_RERANK_TOP_N = RAG_DEFAULTS.RERANK_TOP_N;
const DEFAULT_RELATIVE_SCORE_CUTOFF = RAG_DEFAULTS.RELATIVE_SCORE_CUTOFF;
const DEFAULT_TIMEOUT_MS = RAG_DEFAULTS.TIMEOUT_MS;
const DEFAULT_COLBERT_TOP_K = RAG_DEFAULTS.COLBERT_TOP_K;
const DEFAULT_COLBERT_RERANK_ENABLED = false;
const COLBERT_POST_FILTER_FETCH_MULTIPLIER = 4;
const MAX_COLBERT_FETCH_LIMIT = 1000;
export type RetrievalMode = "colbert";

const AudioHashFilterSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/i, "audioHashes must contain 64-char hex audio hashes")
  .transform((value) => value.toLowerCase());

export const SearchMetadataFiltersSchema = z
  .object({
    audioHashes: z.array(AudioHashFilterSchema).min(1).max(MAX_METADATA_FILTER_VALUES).optional(),
    locationIds: z.array(z.number().int().positive()).min(1).max(MAX_METADATA_FILTER_VALUES).optional(),
    recorderIds: z.array(z.number().int().positive()).min(1).max(MAX_METADATA_FILTER_VALUES).optional(),
    dateYears: z.array(z.number().int().min(1900).max(2100)).min(1).max(MAX_METADATA_FILTER_VALUES).optional(),
    verified: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.audioHashes !== undefined ||
      value.locationIds !== undefined ||
      value.recorderIds !== undefined ||
      value.dateYears !== undefined ||
      value.verified !== undefined,
    {
      message: "metadataFilters must contain at least one filter",
    },
  );

export type SearchMetadataFilters = z.infer<typeof SearchMetadataFiltersSchema>;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  candidateLimit: z.number().int().min(1).max(MAX_CANDIDATE_LIMIT).optional(),
  includeNeighbors: z.boolean().optional(),
  neighborCount: z.number().int().min(0).max(MAX_NEIGHBOR_COUNT).optional(),
  dedupeByAudio: z.boolean().optional(),
  maxPerAudio: z.number().int().min(1).max(MAX_PER_AUDIO_LIMIT).optional(),
  metadataFilters: SearchMetadataFiltersSchema.optional(),
});

export interface RouteParams {
  params: Promise<{ id: string }>;
}

export interface Candidate {
  chunkId: string;
  audioHash: string;
  startSec: number;
  endSec: number;
  text: string;
  runId: string;
  chunkVersion: string;
  embeddingModel: string;
  embeddingModelVersion: string;
  denseRank: number | null;
  sparseRank: number | null;
  denseScore: number | null;
  sparseScore: number | null;
  rrfScore: number;
  rerankScore: number | null;
}

export interface RetrievalPassage {
  chunkId: string;
  audioHash: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface RetrievalNeighbors {
  before: RetrievalPassage[];
  after: RetrievalPassage[];
}

export interface AllowedAudioHashRow {
  audioHash: string;
}

export interface ColbertServiceHit {
  chunkId: string;
  score: number;
}

export interface ColbertLookupChunk {
  chunkId: string;
  audioHash: string;
  startSec: number;
  endSec: number;
  text: string;
  runId: string;
  chunkVersion: string;
}

export interface SearchTimings {
  totalMs: number;
  authMs?: number;
  colbertMs?: number;
  rerankMs?: number;
  metadataMs?: number;
}

export interface SearchTelemetryPayload {
  status: "ok" | "error";
  catalogId: string | null;
  userId: string | null;
  retrievalMode: RetrievalMode;
  backendKey: string;
  queryLength: number;
  limit: number;
  rerankTopN: number;
  fusedCandidates: number;
  resultCount: number;
  timings: SearchTimings;
  errorType?: string;
}

export class RagServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RagServiceError";
  }
}

function parseIntEnv(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  throw new Error(`${name} must be a positive integer. Received: ${value}`);
}

function parseFloatEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number. Received: ${value}`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}. Received: ${value}`);
  }
  return parsed;
}

function parseBooleanEnv(name: string, value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean. Received: ${value}`);
}

export function buildAllowedAudioHashesQuery(
  catalogId: string,
  audioHashes: string[],
  accessLevel: AccessLevel | null | undefined,
  metadataFilters: SearchMetadataFilters | null,
): Prisma.Sql | null {
  if (audioHashes.length === 0) return null;

  const joins: Prisma.Sql[] = [];
  const filters: Prisma.Sql[] = [];

  if (requiresReadyRecordingScope(accessLevel)) {
    filters.push(Prisma.sql`
      AND ce.is_actionable = true
      AND ce.is_published = true
    `);
  }

  if (metadataFilters?.audioHashes && metadataFilters.audioHashes.length > 0) {
    filters.push(Prisma.sql`
      AND ce.audio_hash IN (${Prisma.join(metadataFilters.audioHashes)})
    `);
  }

  const needsMetadataJoin =
    (metadataFilters?.locationIds && metadataFilters.locationIds.length > 0) ||
    (metadataFilters?.recorderIds && metadataFilters.recorderIds.length > 0) ||
    (metadataFilters?.dateYears && metadataFilters.dateYears.length > 0) ||
    metadataFilters?.verified !== undefined;

  if (needsMetadataJoin) {
    joins.push(Prisma.sql`
      INNER JOIN audio_metadata am
        ON am.workflow_group_id = ce.workflow_group_id
       AND am.audio_hash = ce.audio_hash
    `);
  }

  if (metadataFilters?.locationIds && metadataFilters.locationIds.length > 0) {
    filters.push(Prisma.sql`
      AND am.location_id IN (${Prisma.join(metadataFilters.locationIds)})
    `);
  }

  if (metadataFilters?.recorderIds && metadataFilters.recorderIds.length > 0) {
    filters.push(Prisma.sql`
      AND am.recorder_id IN (${Prisma.join(metadataFilters.recorderIds)})
    `);
  }

  if (metadataFilters?.dateYears && metadataFilters.dateYears.length > 0) {
    filters.push(Prisma.sql`
      AND am.date_year IN (${Prisma.join(metadataFilters.dateYears)})
    `);
  }

  if (metadataFilters?.verified !== undefined) {
    filters.push(Prisma.sql`
      AND am.verified = ${metadataFilters.verified}
    `);
  }

  return Prisma.sql`
    SELECT DISTINCT ce.audio_hash AS "audioHash"
    FROM catalog_entry ce
    ${joins.length > 0 ? Prisma.sql`${Prisma.join(joins, "\n")}` : Prisma.empty}
    WHERE ce.workflow_group_id = ${catalogId}
      AND ce.audio_hash IN (${Prisma.join(audioHashes)})
      ${filters.length > 0 ? Prisma.sql`${Prisma.join(filters, "\n")}` : Prisma.empty}
  `;
}

function normalizeColbertIndexDir(value: string): string {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!trimmed) {
    throw new Error("RAG_COLBERT_INDEX_DIR must not be empty.");
  }
  return trimmed.endsWith("/colbert_index") ? trimmed : path.posix.join(trimmed, "colbert_index");
}

export async function resolveColbertIndexDir({
  workflowGroupId,
  backendKey,
  chunkVersion,
  colbertModel,
  colbertRootDir,
  colbertUrl,
  explicitIndexDir,
  timeoutMs,
}: {
  workflowGroupId: string;
  backendKey: string;
  chunkVersion?: string | null;
  colbertModel: string;
  colbertRootDir: string;
  colbertUrl: string;
  explicitIndexDir?: string | null;
  timeoutMs: number;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveColbertServiceUrl(colbertUrl, "/resolve"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        explicitIndexDir && explicitIndexDir.trim()
          ? { explicit_index_dir: normalizeColbertIndexDir(explicitIndexDir) }
          : {
              workflow_group_id: workflowGroupId,
              backend_key: backendKey,
              chunk_version: chunkVersion?.trim() || null,
              colbert_model: colbertModel,
              colbert_root_dir: colbertRootDir,
            },
      ),
      signal: controller.signal,
    });

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new RagServiceError(
        `ColBERT bundle resolution failed (${response.status}): ${body.slice(0, 300)}`,
        502,
      );
    }

    const raw = await response.json();
    const resolvedIndexDir = (raw as { colbert_index_dir?: unknown }).colbert_index_dir;
    if (typeof resolvedIndexDir !== "string" || !resolvedIndexDir.trim()) {
      throw new RagServiceError("Invalid ColBERT resolve payload", 502);
    }
    return resolvedIndexDir;
  } catch (error) {
    if (error instanceof RagServiceError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new RagServiceError("ColBERT bundle resolution timed out", 504);
    }
    throw new RagServiceError("ColBERT bundle resolution failed", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export function getSearchConfig() {
  const resultLimit = Math.min(
    parseIntEnv("RAG_RESULT_LIMIT", process.env.RAG_RESULT_LIMIT, DEFAULT_RESULT_LIMIT),
    MAX_LIMIT,
  );
  const retrievalMode: RetrievalMode = "colbert";
  const rerankEnabled = parseBooleanEnv(
    "RAG_COLBERT_RERANK_ENABLED",
    process.env.RAG_COLBERT_RERANK_ENABLED,
    DEFAULT_COLBERT_RERANK_ENABLED,
  );
  const colbertIndexDir = process.env.RAG_COLBERT_INDEX_DIR?.trim() || null;

  return {
    retrievalMode,
    rerankEnabled,
    backendKey: getRagBackendKey(),
    rerankUrl:
      process.env.RAG_TEI_RERANK_URL ||
      process.env.RAG_RERANK_URL ||
      RAG_DEFAULTS.RERANK_URL,
    colbertUrl: process.env.RAG_COLBERT_URL || RAG_DEFAULTS.COLBERT_URL,
    colbertTopK: parseIntEnv(
      "RAG_COLBERT_TOP_K",
      process.env.RAG_COLBERT_TOP_K,
      DEFAULT_COLBERT_TOP_K,
    ),
    colbertModel: getRagColbertModel(),
    colbertRootDir:
      process.env.RAG_COLBERT_ROOT_DIR?.trim() || RAG_DEFAULTS.COLBERT_ROOT_DIR,
    colbertIndexDir,
    rerankModel: getRagRerankModel(),
    timeoutMs: parseIntEnv("RAG_TEI_TIMEOUT_MS", process.env.RAG_TEI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    rerankTopN: parseIntEnv("RAG_RERANK_TOP_N", process.env.RAG_RERANK_TOP_N, DEFAULT_RERANK_TOP_N),
    resultLimit,
    relativeScoreCutoff: parseFloatEnv(
      "RAG_RELATIVE_SCORE_CUTOFF",
      process.env.RAG_RELATIVE_SCORE_CUTOFF,
      DEFAULT_RELATIVE_SCORE_CUTOFF,
      0,
      1,
    ),
  };
}

export function resolveRerankCandidateLimit(
  requestedCandidateLimit: number | undefined,
  resultLimit: number,
  rerankTopN: number,
): number {
  const requested = requestedCandidateLimit ?? rerankTopN;
  return Math.min(rerankTopN, Math.max(requested, resultLimit));
}

export function shouldOverfetchColbertResults(
  accessLevel: AccessLevel | null | undefined,
  metadataFilters: SearchMetadataFilters | null,
): boolean {
  return requiresReadyRecordingScope(accessLevel) || metadataFilters !== null;
}

export function resolveColbertFetchLimit(baseLimit: number): number {
  return Math.min(MAX_COLBERT_FETCH_LIMIT, baseLimit * COLBERT_POST_FILTER_FETCH_MULTIPLIER);
}

export function collectRerankCandidates(
  candidates: Candidate[],
  candidateLimit: number,
  maxPerAudio: number | null,
): Candidate[] {
  if (candidateLimit <= 0 || candidates.length === 0) return [];
  if (!maxPerAudio || maxPerAudio < 1) {
    return candidates.slice(0, candidateLimit);
  }

  const counts = new Map<string, number>();
  const selected: Candidate[] = [];

  for (const candidate of candidates) {
    const seen = counts.get(candidate.audioHash) ?? 0;
    if (seen >= maxPerAudio) continue;
    counts.set(candidate.audioHash, seen + 1);
    selected.push(candidate);
    if (selected.length >= candidateLimit) break;
  }

  return selected;
}

function candidateScore(candidate: Candidate): number {
  const score = candidate.rerankScore ?? candidate.rrfScore;
  return Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY;
}

export function applyRelativeCutoff(
  candidates: Candidate[],
  relativeCutoff: number,
): Candidate[] {
  if (candidates.length === 0) return [];
  if (relativeCutoff <= 0) return candidates;

  const topScore = candidateScore(candidates[0]);
  if (!Number.isFinite(topScore)) {
    return candidates.slice(0, 1);
  }

  const threshold = topScore - Math.abs(topScore) * (1 - relativeCutoff);
  const filtered = candidates.filter((candidate) => candidateScore(candidate) >= threshold);
  return filtered.length > 0 ? filtered : candidates.slice(0, 1);
}

export function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(2));
}

export function applyTimingHeaders(
  response: { headers: Headers },
  timings: SearchTimings,
): void {
  const parts: string[] = [];
  const entries: Array<[string, number | undefined]> = [
    ["total", timings.totalMs],
    ["auth", timings.authMs],
    ["colbert", timings.colbertMs],
    ["rerank", timings.rerankMs],
    ["metadata", timings.metadataMs],
  ];

  for (const [name, duration] of entries) {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      continue;
    }
    parts.push(`${name};dur=${duration.toFixed(2)}`);
  }

  if (parts.length > 0) {
    response.headers.set("Server-Timing", parts.join(", "));
  }
  response.headers.set("X-Rag-Search-Duration-Ms", timings.totalMs.toFixed(2));
}

export function logSearchTelemetry(payload: SearchTelemetryPayload): void {
  console.info("[RAG Search]", JSON.stringify(payload));
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new RagServiceError(
        `Model service request failed (${response.status}): ${body.slice(0, 300)}`,
        502,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof RagServiceError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new RagServiceError("Model service request timed out", 504);
    }
    throw new RagServiceError("Model service request failed", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function rerankCandidates(
  query: string,
  candidates: Candidate[],
  rerankUrl: string,
  timeoutMs: number,
): Promise<number[]> {
  if (candidates.length === 0) return [];

  const raw = await fetchJsonWithTimeout(
    rerankUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        texts: candidates.map((candidate) => candidate.text),
      }),
    },
    timeoutMs,
  );

  if (!Array.isArray(raw)) {
    throw new RagServiceError("Invalid rerank response payload", 502);
  }

  const scores = new Array<number>(candidates.length).fill(0);
  for (const item of raw) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { index?: unknown }).index !== "number" ||
      typeof (item as { score?: unknown }).score !== "number"
    ) {
      continue;
    }
    const index = (item as { index: number }).index;
    if (index >= 0 && index < scores.length) {
      scores[index] = (item as { score: number }).score;
    }
  }
  return scores;
}

export async function queryColbertService(
  query: string,
  colbertUrl: string,
  colbertIndexDir: string,
  k: number,
  timeoutMs: number,
): Promise<ColbertServiceHit[]> {
  const raw = await fetchJsonWithTimeout(
    resolveColbertServiceUrl(colbertUrl, "/query"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        colbert_index_dir: colbertIndexDir,
        query,
        k,
        force_fast: false,
      }),
    },
    timeoutMs,
  );

  const rawHits = (raw as { hits?: unknown }).hits;
  if (!Array.isArray(rawHits)) {
    throw new RagServiceError("Invalid ColBERT response payload", 502);
  }

  const hits: ColbertServiceHit[] = [];
  for (const item of rawHits) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const chunkId =
      typeof (item as { chunk_id?: unknown }).chunk_id === "string"
        ? ((item as { chunk_id: string }).chunk_id)
        : typeof (item as { document_id?: unknown }).document_id === "string"
          ? ((item as { document_id: string }).document_id)
          : null;
    const score = Number((item as { score?: unknown }).score);
    if (!chunkId || !Number.isFinite(score)) {
      continue;
    }
    hits.push({ chunkId, score });
  }
  return hits;
}

function resolveColbertServiceUrl(colbertUrl: string, endpointPath: string): string {
  const url = new URL(colbertUrl);
  url.pathname = endpointPath;
  url.search = "";
  return url.toString();
}

export async function lookupColbertChunks(
  colbertUrl: string,
  colbertIndexDir: string,
  chunkIds: string[],
  timeoutMs: number,
): Promise<ColbertLookupChunk[]> {
  if (chunkIds.length === 0) return [];

  const raw = await fetchJsonWithTimeout(
    resolveColbertServiceUrl(colbertUrl, "/lookup"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        colbert_index_dir: colbertIndexDir,
        chunk_ids: chunkIds,
      }),
    },
    timeoutMs,
  );

  const rawChunks = (raw as { chunks?: unknown }).chunks;
  if (!Array.isArray(rawChunks)) {
    throw new RagServiceError("Invalid ColBERT lookup payload", 502);
  }

  const chunks: ColbertLookupChunk[] = [];
  for (const item of rawChunks) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const chunkId = typeof (item as { chunk_id?: unknown }).chunk_id === "string"
      ? (item as { chunk_id: string }).chunk_id
      : null;
    const audioHash = typeof (item as { audio_hash?: unknown }).audio_hash === "string"
      ? (item as { audio_hash: string }).audio_hash
      : null;
    const runId = typeof (item as { run_id?: unknown }).run_id === "string"
      ? (item as { run_id: string }).run_id
      : null;
    const chunkVersion = typeof (item as { chunk_version?: unknown }).chunk_version === "string"
      ? (item as { chunk_version: string }).chunk_version
      : null;
    const startSec = Number((item as { start_sec?: unknown }).start_sec);
    const endSec = Number((item as { end_sec?: unknown }).end_sec);
    const text = typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text
      : null;
    if (!chunkId || !audioHash || !runId || !chunkVersion || !text) {
      continue;
    }
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      continue;
    }
    chunks.push({
      chunkId,
      audioHash,
      startSec,
      endSec,
      text,
      runId,
      chunkVersion,
    });
  }
  return chunks;
}

export async function lookupColbertNeighbors(
  colbertUrl: string,
  colbertIndexDir: string,
  chunkIds: string[],
  neighborCount: number,
  timeoutMs: number,
): Promise<Map<string, RetrievalNeighbors>> {
  if (chunkIds.length === 0 || neighborCount <= 0) {
    return new Map<string, RetrievalNeighbors>();
  }

  const raw = await fetchJsonWithTimeout(
    resolveColbertServiceUrl(colbertUrl, "/neighbors"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        colbert_index_dir: colbertIndexDir,
        chunk_ids: chunkIds,
        neighbor_count: neighborCount,
      }),
    },
    timeoutMs,
  );

  const rawNeighbors = (raw as { neighbors?: unknown }).neighbors;
  if (!rawNeighbors || typeof rawNeighbors !== "object" || Array.isArray(rawNeighbors)) {
    throw new RagServiceError("Invalid ColBERT neighbor payload", 502);
  }

  const grouped = new Map<string, RetrievalNeighbors>();
  for (const [chunkId, value] of Object.entries(rawNeighbors)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const before = parseColbertNeighborPassages((value as { before?: unknown }).before);
    const after = parseColbertNeighborPassages((value as { after?: unknown }).after);
    grouped.set(chunkId, { before, after });
  }
  return grouped;
}

function parseColbertNeighborPassages(raw: unknown): RetrievalPassage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const passages: RetrievalPassage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const chunkId = typeof (item as { chunk_id?: unknown }).chunk_id === "string"
      ? (item as { chunk_id: string }).chunk_id
      : null;
    const audioHash = typeof (item as { audio_hash?: unknown }).audio_hash === "string"
      ? (item as { audio_hash: string }).audio_hash
      : null;
    const startSec = Number((item as { start_sec?: unknown }).start_sec);
    const endSec = Number((item as { end_sec?: unknown }).end_sec);
    const text = typeof (item as { text?: unknown }).text === "string"
      ? (item as { text: string }).text
      : null;
    if (!chunkId || !audioHash || !text) {
      continue;
    }
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      continue;
    }
    passages.push({ chunkId, audioHash, startSec, endSec, text });
  }
  return passages;
}

export function materializeColbertCandidates(
  hits: ColbertServiceHit[],
  chunks: ColbertLookupChunk[],
  allowedAudioHashes: Iterable<string>,
  colbertModel: string,
): Candidate[] {
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const allowed = new Set(allowedAudioHashes);

  return hits.reduce<Candidate[]>((acc, hit, index) => {
    const chunk = chunkById.get(hit.chunkId);
    if (!chunk || !allowed.has(chunk.audioHash)) {
      return acc;
    }
    acc.push({
      chunkId: chunk.chunkId,
      audioHash: chunk.audioHash,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      text: chunk.text,
      runId: chunk.runId,
      chunkVersion: chunk.chunkVersion,
      embeddingModel: colbertModel,
      embeddingModelVersion: "",
      denseRank: index + 1,
      sparseRank: null,
      denseScore: hit.score,
      sparseScore: null,
      rrfScore: hit.score,
      rerankScore: null,
    });
    return acc;
  }, []);
}

export function applyMaxPerAudio(candidates: Candidate[], maxPerAudio: number | null): Candidate[] {
  if (!maxPerAudio || maxPerAudio < 1) return candidates;

  const counts = new Map<string, number>();
  const filtered: Candidate[] = [];

  for (const candidate of candidates) {
    const seen = counts.get(candidate.audioHash) ?? 0;
    if (seen >= maxPerAudio) continue;
    counts.set(candidate.audioHash, seen + 1);
    filtered.push(candidate);
  }

  return filtered;
}

export function assembleContextText(primary: Candidate, neighbors: RetrievalNeighbors): string {
  return [...neighbors.before.map((item) => item.text), primary.text, ...neighbors.after.map((item) => item.text)]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}
