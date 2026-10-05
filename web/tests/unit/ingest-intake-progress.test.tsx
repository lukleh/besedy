import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";
import { IntakeProgress } from "@/app/(app)/admin/ingest/intake-progress";
import type { RecordingIntakeDto } from "@/lib/ingest/types";

const NOW = new Date("2026-10-04T13:00:00Z");

function intake(overrides: Partial<RecordingIntakeDto> = {}): RecordingIntakeDto {
  return {
    id: "cmf9abcdefghijklmnopqrstu",
    catalogId: "20260201_120000",
    catalogLabel: "Main",
    originalFilename: "talk.mp3",
    sizeBytes: 7,
    receivedBytes: 7,
    mimeType: "audio/mpeg",
    status: "RUNNING",
    jobId: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b",
    audioHash: null,
    errorCode: null,
    errorMessage: null,
    requestedBy: null,
    createdAt: "2026-10-04T12:40:00.000Z",
    updatedAt: "2026-10-04T12:40:00.000Z",
    finishedAt: null,
    prefectStateName: "Running",
    ...overrides,
  };
}

function renderProgress(row: RecordingIntakeDto) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <IntakeProgress intake={row} />
    </NextIntlClientProvider>
  );
}

describe("IntakeProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the pipeline step with the step and run times", () => {
    renderProgress(
      intake({
        startedAt: "2026-10-04T12:42:00.000Z",
        progressStep: 4,
        progressTotal: 9,
        progressLabel: "transcribe (canary-nemo@lang-cs)",
        progressStepStartedAt: "2026-10-04T12:48:00.000Z",
      })
    );

    expect(screen.getByText("Step 4/9 · transcribe (canary-nemo@lang-cs)")).toBeInTheDocument();
    expect(screen.getByText("12 min (total 18 min)")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });

  it("shows a flow stage without a step number", () => {
    renderProgress(
      intake({
        status: "REMOVING",
        startedAt: "2026-10-04T10:30:00.000Z",
        progressLabel: "catalog remove",
        progressStepStartedAt: "2026-10-04T10:30:00.000Z",
      })
    );

    expect(screen.getByText("catalog remove")).toBeInTheDocument();
    expect(screen.getByText("2 h 30 min (total 2 h 30 min)")).toBeInTheDocument();
  });

  it("falls back to the Prefect state name without progress reports", () => {
    renderProgress(intake());

    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByTestId("ingest-intake-progress")).not.toBeInTheDocument();
  });

  it("shows the total duration of a finished run", () => {
    renderProgress(
      intake({
        status: "SUCCEEDED",
        startedAt: "2026-10-04T10:55:00.000Z",
        finishedAt: "2026-10-04T12:20:00.000Z",
        progressStep: 9,
        progressTotal: 9,
        progressLabel: "cluster-speakers",
        progressStepStartedAt: "2026-10-04T12:18:00.000Z",
      })
    );

    expect(screen.getByText("Took 1 h 25 min")).toBeInTheDocument();
    expect(screen.queryByText(/cluster-speakers/)).not.toBeInTheDocument();
  });
});
