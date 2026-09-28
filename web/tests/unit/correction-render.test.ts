import { describe, expect, it } from "vitest";
import { renderSrt, renderTxt, renderVtt } from "@/lib/correction/render";

const SEGMENTS = [
  { start: 0, end: 2.5, text: "První věta." },
  { start: 2.5, end: 4, text: "Druhá věta." },
];

describe("published sidecar rendering", () => {
  it("writes one segment per line without a trailing newline", () => {
    expect(renderTxt(SEGMENTS)).toBe("První věta.\nDruhá věta.");
  });

  it("numbers SRT cues from one and ends with a newline", () => {
    expect(renderSrt(SEGMENTS)).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:02,500",
        "První věta.",
        "",
        "2",
        "00:00:02,500 --> 00:00:04,000",
        "Druhá věta.",
        "",
      ]
        .join("\n")
        .replace(/\s+$/, "") + "\n"
    );
  });

  it("writes a WEBVTT header and dot-separated timestamps", () => {
    const vtt = renderVtt(SEGMENTS);
    expect(vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:02.500");
  });

  it("skips empty text and zero-length cues, as the machine renderer does", () => {
    const rendered = renderSrt([
      { start: 0, end: 1, text: "kept" },
      { start: 1, end: 1, text: "zero length" },
      { start: 2, end: 3, text: "   " },
    ]);
    expect(rendered).toContain("kept");
    expect(rendered).not.toContain("zero length");
    expect(rendered.trim().split("\n")[0]).toBe("1");
  });

  it("formats hours and rounds milliseconds", () => {
    expect(renderVtt([{ start: 3661.0005, end: 3662, text: "x" }])).toContain(
      "01:01:01.001 --> 01:01:02.000"
    );
  });

  it("returns an empty SRT when nothing is renderable", () => {
    expect(renderSrt([{ start: 0, end: 0, text: "" }])).toBe("");
  });
});
