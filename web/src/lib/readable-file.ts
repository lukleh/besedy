import fs from "fs";

export type ReadableFileCheck =
  | { ok: true; stat: fs.Stats }
  | {
      ok: false;
      reason: "missing" | "unreadable" | "not_a_file";
      code: string | undefined;
      error: unknown;
    };

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Confirm that `filePath` is a regular file this process can read.
 *
 * `stat()` succeeds on an unreadable file and on a directory, and a read
 * stream opened for either only fails asynchronously after the response has
 * been built. Route handlers check first so they can answer with a clean
 * status instead of a truncated body.
 */
export async function checkReadableFile(filePath: string): Promise<ReadableFileCheck> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: "not_a_file", code: undefined, error: undefined };
    }
    await fs.promises.access(filePath, fs.constants.R_OK);
    return { ok: true, stat };
  } catch (error) {
    const code = errnoCode(error);
    const reason = code === "EACCES" || code === "EPERM" ? "unreadable" : "missing";
    return { ok: false, reason, code, error };
  }
}

/**
 * Create a read stream and hand it to `wrap` in the same tick.
 *
 * `fs.createReadStream` opens the file asynchronously. If the open fails
 * before an error listener exists, the error is an uncaught exception, so
 * `wrap` must attach its listeners synchronously and return whatever wraps the
 * stream (normally the response). Routing every stream through this function
 * keeps an `await` from ever sitting between creation and the listeners.
 */
export function openReadStream<T>(
  filePath: string,
  options: { start?: number; end?: number } | undefined,
  wrap: (stream: fs.ReadStream) => T
): T {
  return wrap(fs.createReadStream(filePath, options));
}
