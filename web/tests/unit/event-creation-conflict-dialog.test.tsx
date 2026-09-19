import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EventCreationConflictDialog } from "@/components/catalog/event-creation-conflict-dialog";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "candidateMeta") {
      return `Event ${values?.id}, session ${values?.index}, ${values?.count} recordings`;
    }
    if (key === "eventFallback") return `Event ${values?.id}`;
    return key;
  },
}));

const conflict = {
  reason: "EVENT_CREATION_REQUIRES_DECISION" as const,
  candidates: [
    {
      id: 41,
      title: "Praha, 3 Apr 2024",
      sessionIndex: 1,
      recordingCount: 2,
      primaryTitle: "Morning discussion",
    },
    {
      id: 42,
      title: "Praha, 3 Apr 2024, session 2",
      sessionIndex: 2,
      recordingCount: 1,
      primaryTitle: "Afternoon discussion",
    },
  ],
};

describe("EventCreationConflictDialog", () => {
  it("shows every candidate and reports the selected destination", async () => {
    const user = userEvent.setup();
    const onCandidateAction = vi.fn();

    render(
      <EventCreationConflictDialog
        candidateActionLabel="Attach"
        conflict={conflict}
        isPending={false}
        onCancel={vi.fn()}
        onCandidateAction={onCandidateAction}
        onCreateDistinct={vi.fn()}
      />
    );

    expect(screen.getByText("Morning discussion")).toBeInTheDocument();
    expect(screen.getByText("Afternoon discussion")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Attach" })).toHaveLength(2);

    await user.click(screen.getAllByRole("button", { name: "Attach" })[1]);
    expect(onCandidateAction).toHaveBeenCalledWith(conflict.candidates[1]);
  });

  it("lets the curator explicitly create a distinct event", async () => {
    const user = userEvent.setup();
    const onCreateDistinct = vi.fn();

    render(
      <EventCreationConflictDialog
        candidateActionLabel="Open"
        conflict={conflict}
        isPending={false}
        onCancel={vi.fn()}
        onCandidateAction={vi.fn()}
        onCreateDistinct={onCreateDistinct}
      />
    );

    await user.click(screen.getByRole("button", { name: "createDistinct" }));
    expect(onCreateDistinct).toHaveBeenCalledOnce();
  });
});

describe("EventCreationConflictDialog titles", () => {
  it("names a candidate by its event title when the recording has none", () => {
    // The real same-day pair in the catalog resolves to an untitled recording,
    // so the server sends null rather than "" and the row still reads.
    render(
      <EventCreationConflictDialog
        candidateActionLabel="Attach"
        conflict={{
          reason: "EVENT_CREATION_REQUIRES_DECISION" as const,
          candidates: [
            {
              id: 194,
              title: "Wildenava, 4 Jul 2026",
              sessionIndex: 1,
              recordingCount: 1,
              primaryTitle: null,
            },
          ],
        }}
        isPending={false}
        onCancel={vi.fn()}
        onCandidateAction={vi.fn()}
        onCreateDistinct={vi.fn()}
      />
    );

    expect(screen.getByText("Wildenava, 4 Jul 2026")).toBeInTheDocument();
    expect(screen.queryByText("Event 194")).not.toBeInTheDocument();
  });
});
