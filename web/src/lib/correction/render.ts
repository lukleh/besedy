/**
 * Sidecar rendering for published corrected transcripts.
 *
 * Deliberately mirrors `besedy/lib/analysis/subtitles.py` and the txt sidecar
 * in `besedy/commands/catalog/extract.py`: a reader downloading a corrected
 * transcript should get the same shape of file as a machine one, differing
 * only in the words.
 */

export interface RenderableSegment {
  start: number;
  end: number;
  text: string;
}

function formatTimestamp(seconds: number, separator: string): string {
  const safeSeconds = seconds < 0 ? 0 : seconds;
  let wholeSeconds = Math.floor(safeSeconds);
  let millis = Math.round((safeSeconds - wholeSeconds) * 1000);
  if (millis >= 1000) {
    wholeSeconds += 1;
    millis -= 1000;
  }
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${separator}${pad(millis, 3)}`;
}

/** Plain text, one segment per line. */
export function renderTxt(segments: readonly RenderableSegment[]): string {
  return segments.map((segment) => segment.text).join("\n").trim();
}

export function renderSrt(segments: readonly RenderableSegment[]): string {
  const lines: string[] = [];
  let index = 1;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const start = Math.max(0, segment.start);
    const end = Math.max(0, segment.end);
    if (end <= start) continue;

    lines.push(String(index));
    lines.push(`${formatTimestamp(start, ",")} --> ${formatTimestamp(end, ",")}`);
    lines.push(text);
    lines.push("");
    index += 1;
  }

  if (lines.length === 0) return "";
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

export function renderVtt(segments: readonly RenderableSegment[]): string {
  const lines: string[] = ["WEBVTT", ""];

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const start = Math.max(0, segment.start);
    const end = Math.max(0, segment.end);
    if (end <= start) continue;

    lines.push(`${formatTimestamp(start, ".")} --> ${formatTimestamp(end, ".")}`);
    lines.push(text);
    lines.push("");
  }

  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}
