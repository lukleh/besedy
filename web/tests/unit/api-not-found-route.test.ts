import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/[[...notFound]]/route";

describe("unknown API routes", () => {
  it("is an optional catch-all, so /api itself is covered too", () => {
    // `[[...notFound]]` also matches `/api`; `[...notFound]` would not.
    expect(
      readdirSync(path.resolve(__dirname, "../../src/app/api")).filter((name) => name.includes("notFound"))
    ).toEqual(["[[...notFound]]"]);
  });

  it("answer every method with a JSON 404", async () => {
    for (const handler of [GET, POST, PUT, PATCH, DELETE]) {
      const response = handler();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
    }
  });
});
