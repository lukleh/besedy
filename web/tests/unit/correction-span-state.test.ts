import { describe, expect, it } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { REQUIRED_APPROVALS, SPAN_STATES } from "@/lib/correction/span-state";
import { spanStatesSql } from "@/lib/correction/span-state-sql";

// What makes a span done is decided by one SQL query, `spanStatesSql`, and is
// exercised against a real database by `npm run test:correction-smoke`. These
// checks only pin what can be seen without one.
describe("span state", () => {
  it("fixes the threshold at two people", () => {
    expect(REQUIRED_APPROVALS).toBe(2);
  });

  it("names the four derived states", () => {
    expect([...SPAN_STATES].sort()).toEqual([
      "done",
      "needs_attention",
      "needs_second_approval",
      "not_reviewed",
    ]);
  });

  it("derives every state in the query, objections first", () => {
    const { sql } = spanStatesSql(Prisma.sql`TRUE`);
    const order = SPAN_STATES.map((state) => sql.indexOf(`'${state}'`));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(sql.indexOf("'needs_attention'")).toBeLessThan(sql.indexOf("'done'"));
    expect(sql.indexOf("'done'")).toBeLessThan(sql.indexOf("'needs_second_approval'"));
    expect(sql.indexOf("'needs_second_approval'")).toBeLessThan(sql.indexOf("'not_reviewed'"));
  });

  it("orders each person's decisions by write sequence, not by clock", () => {
    const { sql } = spanStatesSql(Prisma.sql`TRUE`);
    expect(sql).toContain("ORDER BY d.actor_key, d.sequence DESC");
    expect(sql).not.toContain("created_at");
  });

  it("counts only the decisions on the revision it is asked about", () => {
    const { sql } = spanStatesSql(Prisma.sql`TRUE`);
    expect(sql).toContain("d.revision_id = s.current_revision_id");
  });
});
