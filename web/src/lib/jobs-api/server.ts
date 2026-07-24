import type { ZodType } from "zod";

interface FetchJobsApiOptions<T> {
  method?: "GET" | "POST";
  searchParams?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  schema: ZodType<T>;
}

export class JobsApiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobsApiConfigurationError";
  }
}

export class JobsApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "JobsApiError";
    this.status = status;
    this.payload = payload;
  }
}

function getJobsApiConfig() {
  const baseUrl = process.env.JOBS_API_BASE_URL?.trim();
  const secret = process.env.BESEDY_JOB_SERVICE_SECRET?.trim();

  if (!baseUrl) {
    throw new JobsApiConfigurationError("JOBS_API_BASE_URL is not configured");
  }
  if (!secret) {
    throw new JobsApiConfigurationError("BESEDY_JOB_SERVICE_SECRET is not configured");
  }

  return { baseUrl, secret };
}

function buildJobsApiUrl(
  baseUrl: string,
  path: string,
  searchParams?: FetchJobsApiOptions<unknown>["searchParams"]
) {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(normalizedPath, normalizedBaseUrl);

  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === null || value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  return url;
}

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }

  const text = await response.text().catch(() => "");
  return text ? { error: text } : null;
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return fallback;
}

export async function fetchJobsApi<T>(
  path: string,
  options: FetchJobsApiOptions<T>
): Promise<T> {
  const { baseUrl, secret } = getJobsApiConfig();
  const method = options.method ?? "GET";
  const url = buildJobsApiUrl(baseUrl, path, options.searchParams);
  const headers = new Headers({
    Authorization: `Bearer ${secret}`,
  });

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    cache: "no-store",
  });
  const payload = await readPayload(response);

  if (!response.ok) {
    throw new JobsApiError(
      extractErrorMessage(payload, response.statusText || "Jobs API request failed"),
      response.status,
      payload
    );
  }

  return options.schema.parse(payload);
}
