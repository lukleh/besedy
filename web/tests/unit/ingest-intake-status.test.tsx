import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";
import { IntakeStatus } from "@/app/(app)/admin/ingest/intake-status";
import type { RecordingIntakeDto, RecordingIntakeStatus } from "@/lib/ingest/types";

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
    jobStateUnavailable: false,
    ...overrides,
  };
}

function renderStatus(row: RecordingIntakeDto, connectionLost = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <IntakeStatus intake={row} connectionLost={connectionLost} />
    </NextIntlClientProvider>
  );
}

function iconTestIds(): string[] {
  return screen
    .queryAllByTestId(/^ingest-status-icon-/)
    .map((element) => element.getAttribute("data-testid") ?? "");
}

describe("IntakeStatus", () => {
  it.each<[RecordingIntakeStatus, string[]]>([
    ["QUEUED", ["ingest-status-icon-active"]],
    ["RUNNING", ["ingest-status-icon-active"]],
    ["REMOVING", ["ingest-status-icon-active"]],
    ["SUCCEEDED", ["ingest-status-icon-success"]],
    ["REMOVED", ["ingest-status-icon-success"]],
    ["FAILED", ["ingest-status-icon-failed"]],
    ["REJECTED", ["ingest-status-icon-rejected"]],
    ["CANCELLED", []],
    ["UPLOADING", []],
  ])("shows the %s icon next to the badge", (status, expected) => {
    renderStatus(intake({ status }));

    expect(iconTestIds()).toEqual(expected);
    expect(screen.getByText(en.admin.ingest.status[status])).toBeInTheDocument();
    expect(screen.queryByTestId("ingest-intake-warning")).not.toBeInTheDocument();
  });

  it("replaces the spinner with a warning when the page lost the connection", () => {
    renderStatus(intake(), true);

    expect(iconTestIds()).toEqual(["ingest-status-icon-warning"]);
    expect(screen.getByTestId("ingest-intake-warning")).toHaveTextContent(
      "Status is not updating"
    );
  });

  it("replaces the spinner with a warning when the jobs service is unreachable", () => {
    renderStatus(intake({ jobStateUnavailable: true }));

    expect(iconTestIds()).toEqual(["ingest-status-icon-warning"]);
    expect(screen.getByTestId("ingest-intake-warning")).toHaveTextContent(
      "The jobs service cannot be reached"
    );
  });

  it("keeps the final icon of a finished row while the connection is lost", () => {
    renderStatus(intake({ status: "SUCCEEDED", finishedAt: "2026-10-04T12:50:00.000Z" }), true);

    expect(iconTestIds()).toEqual(["ingest-status-icon-success"]);
    expect(screen.queryByTestId("ingest-intake-warning")).not.toBeInTheDocument();
  });
});
