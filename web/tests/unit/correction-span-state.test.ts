import { describe, expect, it } from "vitest";
import {
  deriveSpanState,
  hasBeenReviewed,
  REQUIRED_APPROVALS,
  summarizeSpanDecisions,
  type DecisionRow,
} from "@/lib/correction/span-state";

function at(seconds: number): Date {
  return new Date(2026, 8, 20, 12, 0, seconds);
}

function decision(
  actorKey: string,
  kind: DecisionRow["kind"],
  seconds: number
): DecisionRow {
  return { actorKey, kind, createdAt: at(seconds) };
}

describe("span state", () => {
  it("fixes the threshold at two people", () => {
    expect(REQUIRED_APPROVALS).toBe(2);
  });

  it("is not reviewed with no decisions", () => {
    const summary = summarizeSpanDecisions([]);
    expect(summary.state).toBe("not_reviewed");
    expect(hasBeenReviewed(summary)).toBe(false);
  });

  it("needs a second approval after one person approves", () => {
    const summary = summarizeSpanDecisions([decision("alice", "APPROVE", 1)]);
    expect(summary.state).toBe("needs_second_approval");
    expect(summary.approverIds).toEqual(["alice"]);
    expect(hasBeenReviewed(summary)).toBe(true);
  });

  it("is done once two distinct people approve", () => {
    const summary = summarizeSpanDecisions([
      decision("alice", "APPROVE", 1),
      decision("bob", "APPROVE", 2),
    ]);
    expect(summary.state).toBe("done");
    expect(summary.isDone).toBe(true);
  });

  it("does not count the same person twice", () => {
    const summary = summarizeSpanDecisions([
      decision("alice", "APPROVE", 1),
      decision("alice", "APPROVE", 2),
    ]);
    expect(summary.approverIds).toEqual(["alice"]);
    expect(summary.state).toBe("needs_second_approval");
  });

  it("never outvotes an objection, however many approvals it has", () => {
    const summary = summarizeSpanDecisions([
      decision("alice", "APPROVE", 1),
      decision("bob", "APPROVE", 2),
      decision("carol", "APPROVE", 3),
      decision("dave", "DISAPPROVE", 4),
    ]);
    expect(summary.state).toBe("needs_attention");
    expect(summary.isDone).toBe(false);
  });

  it("lets the latest decision of one person replace their earlier one", () => {
    const summary = summarizeSpanDecisions([
      decision("alice", "DISAPPROVE", 1),
      decision("alice", "APPROVE", 2),
      decision("bob", "APPROVE", 3),
    ]);
    expect(summary.state).toBe("done");
    expect(summary.disapproverIds).toEqual([]);
  });

  it("leaves a withdrawing person with no effective decision", () => {
    const summary = summarizeSpanDecisions([
      decision("alice", "APPROVE", 1),
      decision("bob", "DISAPPROVE", 2),
      decision("bob", "WITHDRAW", 3),
    ]);
    expect(summary.state).toBe("needs_second_approval");
    expect(summary.approverIds).toEqual(["alice"]);
    expect(summary.disapproverIds).toEqual([]);
  });

  it("evaluates attention before done", () => {
    expect(deriveSpanState(5, 1)).toBe("needs_attention");
    expect(deriveSpanState(2, 0)).toBe("done");
    expect(deriveSpanState(1, 0)).toBe("needs_second_approval");
    expect(deriveSpanState(0, 0)).toBe("not_reviewed");
  });
});
