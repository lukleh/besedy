/**
 * End-to-end smoke check for human transcript correction.
 *
 * The unit tests cover each piece against mocks; this drives the whole path
 * against a real database and a real corrections tree, because the parts most
 * likely to be wrong are the seams — the partial unique indexes, the workspace
 * lock, the atomic edit-and-approve, the frozen source on disk, the artifacts
 * the publication job writes and the pointer the Python index build reads.
 *
 * It creates its own catalog, users, recording and data root, so point it at a
 * throwaway database rather than a real one:
 *
 *   docker run -d --name besedy-correction-smoke \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=besedy_check \
 *     -p 55432:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:test@localhost:55432/besedy_check \
 *     npx prisma migrate deploy
 *   DATABASE_URL=postgresql://postgres:test@localhost:55432/besedy_check \
 *     npm run test:correction-smoke
 *
 * It prints the corrections root it wrote, so the Python side can be checked
 * against the same tree with `discover_transcript_sources`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "besedy-correction-"));
const dataDir = path.join(root, "data");
const transcriptsDir = path.join(dataDir, "transcripts");
const correctionsDir = path.join(dataDir, "corrections");
fs.mkdirSync(transcriptsDir, { recursive: true });
fs.mkdirSync(correctionsDir, { recursive: true });

// Unique per run, so the script can be run repeatedly against the same
// throwaway database instead of failing on the second attempt.
const now = new Date();
const CATALOG_ID = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
  "_",
  String(now.getHours()).padStart(2, "0"),
  String(now.getMinutes()).padStart(2, "0"),
  String(now.getSeconds()).padStart(2, "0"),
].join("");
const AUDIO_HASH = createHash("sha256").update(randomUUID()).digest("hex");
const BACKEND_WORKFLOW = "faster-whisper";
const BACKEND_MODEL = "large-v3@silero_vad_v6@lang-cs";
const BACKEND = `${BACKEND_WORKFLOW}/${BACKEND_MODEL}`;
process.env.RAG_BACKEND_KEY = BACKEND;

const machineDir = path.join(transcriptsDir, `transcripts_${CATALOG_ID}`, BACKEND_WORKFLOW, BACKEND_MODEL, AUDIO_HASH);
fs.mkdirSync(machineDir, { recursive: true });
fs.writeFileSync(
  path.join(machineDir, "transcript.json"),
  JSON.stringify(
    {
      meta: {
        backend: "faster-whisper",
        model: "large-v3",
        audio_filepath: `/audio/${AUDIO_HASH}.wav`,
        duration: 12,
        generation_params: { beam_size: 5 },
        transcript_text: "Dobry den vsichni. Vitejte na besede.",
        num_segments: 2,
        num_words: 6,
      },
      segments: [
        {
          start: 0,
          end: 5,
          text: "Dobry den vsichni.",
          words: [{ word: "Dobry" }],
          confidence: 0.7,
        },
        {
          start: 5,
          end: 12,
          text: "Vitejte na besede.",
          words: [],
          confidence: 0.6,
        },
      ],
    },
    null,
    2
  )
);

const configPath = path.join(root, "besedy.toml");
fs.writeFileSync(
  configPath,
  `[paths]\ntext_data_dir = "${dataDir}"\ntranscripts_dir = "transcripts"\ncorrections_dir = "${correctionsDir}"\n`
);
process.env.BESEDY_CONFIG = configPath;
process.env.BESEDY_BASE_DIR = dataDir;

const failures: string[] = [];
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`, detail ?? "");
  }
}

async function main() {
  const prisma = (await import("@/lib/db")).default;
  const { startWorkspace, listSpans, computeProgress, archiveWorkspace, findResumePosition } =
    await import("@/lib/correction/workspace-service");
  const { saveAndApprove, recordDecision, listSpanHistory } = await import("@/lib/correction/decision-service");
  const { getPublicationEligibility } = await import("@/lib/correction/publication-eligibility");
  const {
    publishTranscript,
    unpublishTranscript,
    withdrawFromSearch,
    reconcilePublication,
    rollbackPublication,
    completeIndexSync,
  } = await import("@/lib/correction/publication-service");
  const { resolveReaderTranscriptSource, resolveSearchTranscriptSource, resolveOriginalTranscriptSource } =
    await import("@/lib/correction/resolve");
  const { readIndexPointer, resolvePublicationFilePath, writeIndexPointer } = await import("@/lib/correction/storage");

  // Publication waits for the search index, which the host worker builds. The
  // smoke check stands in for that worker: it records what the publication
  // service asked for and reports completion by hand, so the state machine is
  // exercised without Prefect. Paths are reported the way the worker sees
  // them, under its own mount, because that is what the web side must accept.
  const indexSyncRequests: Array<{ operation: string; operationToken: string; attempt: number }> = [];
  let failNextIndexSyncSubmit = false;
  const deps = {
    indexSync: async (request: { operation: string; operationToken: string; attempt: number }) => {
      if (failNextIndexSyncSubmit) {
        failNextIndexSyncSubmit = false;
        throw new Error("jobs API unreachable");
      }
      indexSyncRequests.push({
        operation: request.operation,
        operationToken: request.operationToken,
        attempt: request.attempt,
      });
      return { jobId: randomUUID() };
    },
  };
  const hostCorrectionsRoot = "/host/besedy_corrections";
  const indexedPathFor = (workspaceId: string, publicationId: string) =>
    `${hostCorrectionsRoot}/corrections_${CATALOG_ID}/${workspaceId}/publications/${publicationId}/transcript.json`;
  const machineIndexedPath = `/host/besedy_data/transcripts/transcripts_${CATALOG_ID}/${BACKEND}/${AUDIO_HASH}/transcript.json`;
  const publicationStatus = async (publicationId: string) =>
    (
      await prisma.transcriptPublication.findUniqueOrThrow({
        where: { id: publicationId },
        select: { status: true },
      })
    ).status;

  // --- fixture -------------------------------------------------------------
  const alice = await prisma.user.create({
    data: {
      id: `alice-${randomUUID()}`,
      email: `alice-${randomUUID()}@example.test`,
      status: "ACTIVE",
    },
  });
  const bob = await prisma.user.create({
    data: {
      id: `bob-${randomUUID()}`,
      email: `bob-${randomUUID()}@example.test`,
      status: "ACTIVE",
    },
  });
  await prisma.workflowGroup.create({
    data: {
      id: CATALOG_ID,
      archivedCatalogPath: "/tmp/archived.csv",
      metadataCatalogPath: "/tmp/metadata.csv",
    },
  });
  await prisma.catalogEntry.create({
    data: {
      workflowGroupId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
    },
  });
  const location = await prisma.location.create({
    data: { workflowGroupId: CATALOG_ID, name: "Test place" },
  });
  const event = await prisma.catalogEvent.create({
    data: {
      workflowGroupId: CATALOG_ID,
      locationId: location.id,
      dateYear: 2026,
      createdById: alice.id,
      updatedById: alice.id,
    },
  });
  await prisma.catalogEventRecording.create({
    data: {
      eventId: event.id,
      workflowGroupId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      isPrimary: true,
    },
  });

  // --- before correction ---------------------------------------------------
  console.log("\nbefore correction starts");
  check(
    "reader withholds an eligible primary transcript",
    (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "withheld"
  );
  check(
    "search keeps the machine transcript",
    (await resolveSearchTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "machine"
  );
  check(
    "privileged original is the configured machine transcript",
    (await resolveOriginalTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "machine"
  );

  // --- start ---------------------------------------------------------------
  console.log("\nstarting correction");
  const workspace = await startWorkspace({
    catalogId: CATALOG_ID,
    audioHash: AUDIO_HASH,
    transcriptsPath: path.join(transcriptsDir, `transcripts_${CATALOG_ID}`),
    userId: alice.id,
  });
  check("freezes the configured default backend", workspace.sourceBackend === BACKEND, workspace.sourceBackend);
  check("imports every segment as a span", workspace.spanCount === 2, workspace.spanCount);
  check("records the span duration", workspace.spanDurationSeconds === 12, workspace.spanDurationSeconds);

  let startedTwice = false;
  try {
    await startWorkspace({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      transcriptsPath: path.join(transcriptsDir, `transcripts_${CATALOG_ID}`),
      userId: bob.id,
    });
    startedTwice = true;
  } catch {
    // expected
  }
  check("refuses a second live workspace", !startedTwice);

  check(
    "privileged original becomes the frozen source",
    (await resolveOriginalTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "frozen"
  );

  // --- correcting ----------------------------------------------------------
  console.log("\ncorrecting");
  const page = await listSpans(workspace.id);
  const [first] = page.spans;
  check("spans start not reviewed", first.state === "not_reviewed", first.state);

  const edited = await saveAndApprove({
    workspaceId: workspace.id,
    spanId: first.id,
    userId: alice.id,
    expectedRevisionId: first.revisionId,
    text: "Dobrý den všichni.",
  });
  check("an edit plus its approval needs a second person", edited.state === "needs_second_approval", edited.state);
  check("the edit created a new revision", edited.revisionId !== first.revisionId);

  let staleRejected = false;
  try {
    await saveAndApprove({
      workspaceId: workspace.id,
      spanId: first.id,
      userId: bob.id,
      expectedRevisionId: first.revisionId,
      text: "something else",
    });
  } catch (error) {
    staleRejected = (error as { code?: string }).code === "REVISION_CONFLICT";
  }
  check("a stale revision is rejected", staleRejected);

  const key = randomUUID();
  const firstCall = await recordDecision({
    workspaceId: workspace.id,
    spanId: first.id,
    userId: bob.id,
    expectedRevisionId: edited.revisionId,
    kind: "APPROVE",
    idempotencyKey: key,
  });
  const replay = await recordDecision({
    workspaceId: workspace.id,
    spanId: first.id,
    userId: bob.id,
    expectedRevisionId: edited.revisionId,
    kind: "APPROVE",
    idempotencyKey: key,
  });
  check("two distinct approvals finish a span", firstCall.state === "done", firstCall.state);
  check("a replayed idempotency key changes nothing", replay.replayed && replay.approverIds.length === 2);

  let reusedKeyRefused: string | null = null;
  try {
    await recordDecision({
      workspaceId: workspace.id,
      spanId: first.id,
      userId: bob.id,
      expectedRevisionId: edited.revisionId,
      kind: "DISAPPROVE",
      idempotencyKey: key,
    });
  } catch (error) {
    reusedKeyRefused = (error as { code?: string }).code ?? null;
  }
  check(
    "the same key cannot be reused for a different action",
    reusedKeyRefused === "IDEMPOTENCY_CONFLICT",
    reusedKeyRefused
  );

  // An edit and a bare approval both record APPROVE, so the decision kind
  // cannot tell them apart; the command identity has to.
  const editKey = randomUUID();
  const editSpan = (await listSpans(workspace.id)).spans[1];
  await saveAndApprove({
    workspaceId: workspace.id,
    spanId: editSpan.id,
    userId: alice.id,
    expectedRevisionId: editSpan.revisionId,
    text: "first wording",
    idempotencyKey: editKey,
  });

  let secondEditRefused: string | null = null;
  try {
    const current = (await listSpans(workspace.id)).spans[1];
    await saveAndApprove({
      workspaceId: workspace.id,
      spanId: current.id,
      userId: alice.id,
      expectedRevisionId: current.revisionId,
      text: "different wording",
      idempotencyKey: editKey,
    });
  } catch (error) {
    secondEditRefused = (error as { code?: string }).code ?? null;
  }
  check(
    "a different edit under the same key is refused, not silently dropped",
    secondEditRefused === "IDEMPOTENCY_CONFLICT",
    secondEditRefused
  );
  check(
    "the first wording is still the current text",
    (await listSpans(workspace.id)).spans[1].text === "first wording",
    (await listSpans(workspace.id)).spans[1].text
  );

  // Two identical requests arriving together must both succeed, one of them by
  // replaying the other, rather than the loser hitting the unique constraint.
  const concurrentKey = randomUUID();
  const concurrentSpan = (await listSpans(workspace.id)).spans[0];
  const concurrent = await Promise.allSettled([
    recordDecision({
      workspaceId: workspace.id,
      spanId: concurrentSpan.id,
      userId: alice.id,
      expectedRevisionId: concurrentSpan.revisionId,
      kind: "APPROVE",
      idempotencyKey: concurrentKey,
    }),
    recordDecision({
      workspaceId: workspace.id,
      spanId: concurrentSpan.id,
      userId: alice.id,
      expectedRevisionId: concurrentSpan.revisionId,
      kind: "APPROVE",
      idempotencyKey: concurrentKey,
    }),
  ]);
  check(
    "simultaneous identical requests both succeed, one as a replay",
    concurrent.every((outcome) => outcome.status === "fulfilled") &&
      concurrent.some((outcome) => outcome.status === "fulfilled" && outcome.value.replayed),
    concurrent.map((o) =>
      o.status === "fulfilled" ? `ok replayed=${o.value.replayed}` : `rejected ${(o.reason as { code?: string }).code}`
    )
  );

  // The same action on a later revision is a different command.
  const staleKey = randomUUID();
  const revisionSpan = (await listSpans(workspace.id)).spans[1];
  await recordDecision({
    workspaceId: workspace.id,
    spanId: revisionSpan.id,
    userId: bob.id,
    expectedRevisionId: revisionSpan.revisionId,
    kind: "APPROVE",
    idempotencyKey: staleKey,
  });
  await saveAndApprove({
    workspaceId: workspace.id,
    spanId: revisionSpan.id,
    userId: alice.id,
    expectedRevisionId: revisionSpan.revisionId,
    text: "moved on",
  });
  let staleRevisionRefused: string | null = null;
  try {
    const moved = (await listSpans(workspace.id)).spans[1];
    await recordDecision({
      workspaceId: workspace.id,
      spanId: moved.id,
      userId: bob.id,
      expectedRevisionId: moved.revisionId,
      kind: "APPROVE",
      idempotencyKey: staleKey,
    });
  } catch (error) {
    staleRevisionRefused = (error as { code?: string }).code ?? null;
  }
  check(
    "the same key on a later revision is refused, not replayed",
    staleRevisionRefused === "IDEMPOTENCY_CONFLICT",
    staleRevisionRefused
  );

  // The idempotency checks above edited this span, so work from its current
  // revision rather than the one captured when the page was first listed.
  const secondNow = (await listSpans(workspace.id)).spans[1];
  await recordDecision({
    workspaceId: workspace.id,
    spanId: secondNow.id,
    userId: alice.id,
    expectedRevisionId: secondNow.revisionId,
    kind: "DISAPPROVE",
  });
  await recordDecision({
    workspaceId: workspace.id,
    spanId: secondNow.id,
    userId: bob.id,
    expectedRevisionId: secondNow.revisionId,
    kind: "APPROVE",
  });
  const blocked = await getPublicationEligibility(workspace.id);
  check("an objection blocks publication however many approve", !blocked.eligible, blocked);

  let refusedWhileBlocked = false;
  try {
    await publishTranscript({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
    }, deps);
  } catch (error) {
    refusedWhileBlocked = (error as { code?: string }).code === "NOT_ELIGIBLE_FOR_PUBLICATION";
  }
  check("publication refuses a disputed transcript", refusedWhileBlocked);

  await recordDecision({
    workspaceId: workspace.id,
    spanId: secondNow.id,
    userId: alice.id,
    expectedRevisionId: secondNow.revisionId,
    kind: "WITHDRAW",
  });
  await recordDecision({
    workspaceId: workspace.id,
    spanId: secondNow.id,
    userId: alice.id,
    expectedRevisionId: secondNow.revisionId,
    kind: "APPROVE",
  });
  const eligibility = await getPublicationEligibility(workspace.id);
  check("withdrawing an objection unblocks it", eligibility.eligible, eligibility);

  const progress = await computeProgress(workspace.id);
  check("progress is measured in audio", progress.fullyApprovedDurationSeconds === 12, progress);

  // --- the publication lock ------------------------------------------------
  // A disapproval racing a publish must not end with both succeeding: that is
  // a disputed span inside a published snapshot. Either order is acceptable.
  console.log("\nracing a decision against a publication");
  const racedSpan = (await listSpans(workspace.id)).spans[0];
  const [publishOutcome, decisionOutcome] = await Promise.allSettled([
    publishTranscript({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
    }, deps),
    recordDecision({
      workspaceId: workspace.id,
      spanId: racedSpan.id,
      userId: bob.id,
      expectedRevisionId: racedSpan.revisionId,
      kind: "DISAPPROVE",
    }),
  ]);

  const publishWon = publishOutcome.status === "fulfilled";
  const decisionWon = decisionOutcome.status === "fulfilled";
  const disputedInSnapshot =
    publishWon &&
    decisionWon &&
    (await prisma.transcriptPublicationSpan.count({
      where: {
        publicationId: publishOutcome.value.publicationId,
        revisionId: racedSpan.revisionId,
      },
    })) > 0;
  check("a disputed span is never inside a published snapshot", !disputedInSnapshot, {
    publishWon,
    decisionWon,
  });

  if (publishWon) {
    // The publication that won is waiting for the search index; confirm it so
    // the workspace unlocks for the rest of the run.
    await completeIndexSync(
      {
        catalogId: CATALOG_ID,
        audioHash: AUDIO_HASH,
        operation: "publish",
        operationToken: publishOutcome.value.publicationId,
        status: "SUCCEEDED",
        transcriptFingerprint: "e".repeat(64),
        transcriptPath: indexedPathFor(workspace.id, publishOutcome.value.publicationId),
      },
      deps
    );
    // Return to a machine source so the rollback checks below always exercise
    // a machine transcript that belongs to the active search backend.
    await withdrawFromSearch(CATALOG_ID, AUDIO_HASH, deps);
    const withdrawal = await prisma.transcriptWorkspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { searchWithdrawalId: true },
    });
    await completeIndexSync(
      {
        catalogId: CATALOG_ID,
        audioHash: AUDIO_HASH,
        operation: "withdraw",
        operationToken: withdrawal.searchWithdrawalId!,
        status: "SUCCEEDED",
        transcriptFingerprint: "m".repeat(64),
        transcriptPath: machineIndexedPath,
      },
      deps
    );
  }

  // Put the span back into an approved state for the rest of the run.
  if (decisionWon) {
    const current = (await listSpans(workspace.id)).spans[0];
    await recordDecision({
      workspaceId: workspace.id,
      spanId: current.id,
      userId: bob.id,
      expectedRevisionId: current.revisionId,
      kind: "WITHDRAW",
    });
    await recordDecision({
      workspaceId: workspace.id,
      spanId: current.id,
      userId: bob.id,
      expectedRevisionId: current.revisionId,
      kind: "APPROVE",
    });
  }

  // --- resuming and attribution --------------------------------------------
  console.log("\nresuming, and naming who acted");
  const resumeForBob = await findResumePosition(workspace.id, bob.id);
  check(
    "resume skips what this person already approved",
    resumeForBob === null || resumeForBob.ordinal > 0,
    resumeForBob
  );

  const historySpan = (await listSpans(workspace.id)).spans[0];
  const history = await listSpanHistory(workspace.id, historySpan.id);
  check(
    "history names the people in it",
    history.some((entry) => entry.actorName !== null),
    history.map((entry) => entry.actorName)
  );

  // --- publishing ----------------------------------------------------------
  console.log("\npublishing");

  // Change the text once more, so the publication below is a new snapshot
  // whichever side won the race above, and re-approve it.
  const refreshSpan = (await listSpans(workspace.id)).spans[1];
  const refreshed = await saveAndApprove({
    workspaceId: workspace.id,
    spanId: refreshSpan.id,
    userId: alice.id,
    expectedRevisionId: refreshSpan.revisionId,
    text: "Vítejte na dnešní besedě.",
  });
  await recordDecision({
    workspaceId: workspace.id,
    spanId: refreshSpan.id,
    userId: bob.id,
    expectedRevisionId: refreshed.revisionId,
    kind: "APPROVE",
  });

  // The jobs API being down must not lose rendered work: the publication
  // records why it stalled, and publishing again picks it up rather than
  // making a second one.
  failNextIndexSyncSubmit = true;
  const stalled = await publishTranscript(
    { catalogId: CATALOG_ID, audioHash: AUDIO_HASH, userId: alice.id },
    deps
  );
  check(
    "a failed job submission is reported on the publication",
    stalled.status === "ACTIVATING" && stalled.error?.code === "INDEX_SYNC_SUBMIT_FAILED",
    stalled
  );
  const resumed = await publishTranscript(
    { catalogId: CATALOG_ID, audioHash: AUDIO_HASH, userId: alice.id },
    deps
  );
  check(
    "publishing again resumes the stalled publication and clears the error",
    resumed.resumed && resumed.publicationId === stalled.publicationId && resumed.error === null,
    resumed
  );
  // Roll it back so the ordinary path below starts clean; it is activating,
  // so the search side has to confirm before it is gone.
  await rollbackPublication(stalled.publicationId, workspace.id, deps);
  const missingMachineRollback = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "rollback",
      operationToken: stalled.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: null,
      transcriptPath: null,
    },
    deps
  );
  check(
    "rollback waits when the in-scope machine transcript is missing from search",
    missingMachineRollback.outcome === "source_mismatch" &&
      (await publicationStatus(stalled.publicationId)) === "ROLLING_BACK",
    missingMachineRollback
  );
  await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "rollback",
      operationToken: stalled.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: "b".repeat(64),
      transcriptPath: machineIndexedPath,
    },
    deps
  );
  check(
    "the stalled publication is rolled back once search confirms",
    (await publicationStatus(stalled.publicationId)) === "ROLLED_BACK"
  );

  // A pending publication has told the index nothing, so rolling it back
  // needs no job. Reproduce the crash between the manifest and the render.
  const pendingId = randomUUID();
  await prisma.transcriptPublication.create({
    data: {
      id: pendingId,
      workspaceId: workspace.id,
      workflowGroupId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      status: "PENDING",
      requiredApprovals: 2,
      publishedById: alice.id,
      spanCount: 2,
      durationSeconds: 12,
      previousSourceKind: "machine",
      previousSourceRef: BACKEND,
    },
  });
  const requestsBeforePendingRollback = indexSyncRequests.length;
  const pendingRollback = await rollbackPublication(pendingId, workspace.id, deps);
  check(
    "rolling back a pending publication finishes at once without a job",
    pendingRollback === "ROLLED_BACK" &&
      (await publicationStatus(pendingId)) === "ROLLED_BACK" &&
      indexSyncRequests.length === requestsBeforePendingRollback,
    pendingRollback
  );

  const published = await publishTranscript(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
    },
    deps
  );
  check("publication waits for the search index", published.status === "ACTIVATING" && !published.reused, published);
  check(
    "the index sync was requested for this publication",
    indexSyncRequests.some(
      (request) => request.operation === "publish" && request.operationToken === published.publicationId
    ),
    indexSyncRequests
  );
  check(
    "the pointer is published as activating before the database moves",
    (await readIndexPointer(CATALOG_ID, AUDIO_HASH))?.state === "activating"
  );
  const readerWhileActivating = await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH);
  check(
    "the reader is unchanged while the index catches up",
    readerWhileActivating.kind !== "publication" ||
      readerWhileActivating.publicationId !== published.publicationId,
    readerWhileActivating
  );

  const mismatch = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "publish",
      operationToken: published.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: "1".repeat(64),
      transcriptPath: indexedPathFor(workspace.id, randomUUID()),
    },
    deps
  );
  check(
    "a report naming a different source does not publish",
    mismatch.outcome === "source_mismatch" && (await publicationStatus(published.publicationId)) === "ACTIVATING",
    mismatch
  );

  const failedSync = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "publish",
      operationToken: published.publicationId,
      status: "FAILED",
      errorCode: "rag_colbert_index_failed",
      errorMessage: "the worker fell over",
    },
    deps
  );
  const afterFailure = await prisma.transcriptPublication.findUniqueOrThrow({
    where: { id: published.publicationId },
    select: { status: true, errorCode: true },
  });
  check(
    "a failed sync is recorded and the publication keeps waiting",
    failedSync.outcome === "failure_recorded" &&
      afterFailure.status === "ACTIVATING" &&
      afterFailure.errorCode === "rag_colbert_index_failed",
    afterFailure
  );

  const resubmitted = await reconcilePublication(published.publicationId, workspace.id, deps);
  check(
    "reconciling without a report asks the worker again",
    resubmitted === "ACTIVATING" &&
      indexSyncRequests.filter((request) => request.operationToken === published.publicationId).length >= 2,
    indexSyncRequests
  );

  const completed = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "publish",
      operationToken: published.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: "f".repeat(64),
      transcriptPath: indexedPathFor(workspace.id, published.publicationId),
    },
    deps
  );
  const publishedRow = await prisma.transcriptPublication.findUniqueOrThrow({
    where: { id: published.publicationId },
    select: { status: true, searchSourceFingerprint: true, errorCode: true },
  });
  check(
    "the publication succeeds once search confirms the text",
    completed.outcome === "published" && publishedRow.status === "SUCCEEDED",
    { completed, publishedRow }
  );
  check(
    "the publication records what search indexed",
    publishedRow.searchSourceFingerprint === "f".repeat(64) && publishedRow.errorCode === null,
    publishedRow
  );
  check(
    "a late duplicate report is ignored",
    (
      await completeIndexSync(
        {
          catalogId: CATALOG_ID,
          audioHash: AUDIO_HASH,
          operation: "publish",
          operationToken: published.publicationId,
          status: "SUCCEEDED",
          transcriptFingerprint: "f".repeat(64),
          transcriptPath: indexedPathFor(workspace.id, published.publicationId),
        },
        deps
      )
    ).outcome === "already_final"
  );

  for (const format of ["json", "txt", "srt", "vtt"] as const) {
    const artifact = resolvePublicationFilePath(CATALOG_ID, workspace.id, published.publicationId, format);
    check(`renders transcript.${format}`, fs.existsSync(artifact), artifact);
  }

  const document = JSON.parse(
    fs.readFileSync(resolvePublicationFilePath(CATALOG_ID, workspace.id, published.publicationId, "json"), "utf-8")
  );
  check(
    "published JSON carries the corrected text",
    document.meta.transcript_text.includes("Dobrý den"),
    document.meta.transcript_text
  );
  check("published JSON keeps the honest backend", document.meta.backend === "faster-whisper");
  check("published JSON omits num_words", !("num_words" in document.meta));
  check(
    "published segments are text-only",
    document.segments.every(
      (s: { words: unknown[]; confidence: null }) => s.words.length === 0 && s.confidence === null
    )
  );
  check("published JSON records provenance", document.meta.correction.required_approvals === 2);

  const pointer = await readIndexPointer(CATALOG_ID, AUDIO_HASH);
  check("an index pointer is published for the search side", pointer?.state === "active", pointer);
  check(
    "the pointer carries the artifact's real hash, which the indexer verifies",
    pointer !== null &&
      createHash("sha256")
        .update(
          fs.readFileSync(
            resolvePublicationFilePath(CATALOG_ID, workspace.id, published.publicationId, "json"),
            "utf-8"
          )
        )
        .digest("hex") === pointer.artifact_sha256
  );

  check(
    "the reader now resolves the publication",
    (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "publication"
  );
  check(
    "search now resolves the publication",
    (await resolveSearchTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "publication"
  );

  // --- recovery is scoped to the workspace it was asked about --------------
  // Against a second real workspace, not a made-up id: a missing workspace is
  // refused by the lock before ownership is ever considered, which would test
  // the wrong guard.
  const otherHash = createHash("sha256").update(randomUUID()).digest("hex");
  const otherDir = path.join(transcriptsDir, `transcripts_${CATALOG_ID}`, BACKEND_WORKFLOW, BACKEND_MODEL, otherHash);
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, "transcript.json"),
    JSON.stringify({
      meta: {
        backend: "faster-whisper",
        model: "large-v3",
        audio_filepath: `/audio/${otherHash}.wav`,
        duration: 4,
        generation_params: {},
      },
      segments: [{ start: 0, end: 4, text: "Jina nahravka." }],
    })
  );
  await prisma.catalogEntry.create({
    data: {
      workflowGroupId: CATALOG_ID,
      audioHash: otherHash,
      hasArchived: true,
      hasMetadata: true,
      isActionable: true,
      isPublished: true,
    },
  });
  const otherEvent = await prisma.catalogEvent.create({
    data: {
      workflowGroupId: CATALOG_ID,
      locationId: location.id,
      dateYear: 2026,
      sessionIndex: 2,
      createdById: alice.id,
      updatedById: alice.id,
    },
  });
  await prisma.catalogEventRecording.create({
    data: {
      eventId: otherEvent.id,
      workflowGroupId: CATALOG_ID,
      audioHash: otherHash,
      isPrimary: true,
    },
  });
  const otherWorkspace = await startWorkspace({
    catalogId: CATALOG_ID,
    audioHash: otherHash,
    transcriptsPath: path.join(transcriptsDir, `transcripts_${CATALOG_ID}`),
    userId: alice.id,
  });
  const foreignWorkspaceId = otherWorkspace.id;
  let reconcileRefused = false;
  try {
    await reconcilePublication(published.publicationId, foreignWorkspaceId);
  } catch (error) {
    reconcileRefused = (error as { code?: string }).code === "PUBLICATION_NOT_FOUND";
  }
  check("reconciling refuses a publication from another workspace", reconcileRefused);

  let rollbackRefused = false;
  try {
    await rollbackPublication(published.publicationId, foreignWorkspaceId, deps);
  } catch (error) {
    rollbackRefused = (error as { code?: string }).code === "PUBLICATION_NOT_FOUND";
  }
  check("rolling back refuses a publication from another workspace", rollbackRefused);

  // Reproduce a crash just after rollback intent committed: web resolution
  // has returned to the previous source while the index pointer is still on
  // the newer one. Resuming restores the pointer, and any later replay is a
  // true no-op.
  const pointerBefore = await readIndexPointer(CATALOG_ID, AUDIO_HASH);
  const previousSource = await prisma.transcriptPublication.findUniqueOrThrow({
    where: { id: published.publicationId },
    select: { previousSourceKind: true, previousSourceRef: true },
  });
  // What search should hold once this publication is rolled back: the
  // publication before it if the race above published one, else machine text.
  const previousPublicationId =
    previousSource.previousSourceKind === "publication" ? previousSource.previousSourceRef : null;
  const restoredPath = previousPublicationId
    ? indexedPathFor(workspace.id, previousPublicationId)
    : machineIndexedPath;
  const pointerIsRestored = (pointer: Awaited<ReturnType<typeof readIndexPointer>>) =>
    previousPublicationId ? pointer?.publication_id === previousPublicationId : pointer === null;

  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: { readerPublicationId: null, searchPublicationId: null },
  });
  await prisma.transcriptPublication.update({
    where: { id: published.publicationId },
    data: { status: "ROLLING_BACK" },
  });
  check(
    "an interrupted rollback leaves search ahead of web resolution",
    pointerBefore !== null &&
      (await resolveSearchTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "machine"
  );

  await rollbackPublication(published.publicationId, workspace.id, deps);
  check(
    "resuming rollback restores the previous pointer and waits for search",
    pointerIsRestored(await readIndexPointer(CATALOG_ID, AUDIO_HASH)) &&
      (await publicationStatus(published.publicationId)) === "ROLLING_BACK" &&
      indexSyncRequests.some(
        (request) => request.operation === "rollback" && request.operationToken === published.publicationId
      ),
    { previousPublicationId, indexSyncRequests }
  );

  const wrongRollback = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "rollback",
      operationToken: published.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: "9".repeat(64),
      transcriptPath: indexedPathFor(workspace.id, published.publicationId),
    },
    deps
  );
  check(
    "a rollback report still naming the abandoned publication is refused",
    wrongRollback.outcome === "source_mismatch" && (await publicationStatus(published.publicationId)) === "ROLLING_BACK",
    wrongRollback
  );

  const rolledBack = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "rollback",
      operationToken: published.publicationId,
      status: "SUCCEEDED",
      transcriptFingerprint: "m".repeat(64),
      transcriptPath: restoredPath,
    },
    deps
  );
  check(
    "rollback completes once search holds the previous source",
    rolledBack.outcome === "rolled_back" && (await publicationStatus(published.publicationId)) === "ROLLED_BACK",
    rolledBack
  );

  await rollbackPublication(published.publicationId, workspace.id, deps);
  check(
    "replaying a finished rollback leaves the pointer alone",
    pointerIsRestored(await readIndexPointer(CATALOG_ID, AUDIO_HASH))
  );

  // Restore the successful publication for the ordinary unpublish/republish
  // path below; the checks above deliberately exercised its recovery states.
  if (pointerBefore) await writeIndexPointer(pointerBefore);
  await prisma.transcriptPublication.update({
    where: { id: published.publicationId },
    data: { status: "SUCCEEDED" },
  });
  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: {
      readerPublicationId: published.publicationId,
      searchPublicationId: published.publicationId,
    },
  });

  // --- republishing an unchanged snapshot ----------------------------------
  await unpublishTranscript({ catalogId: CATALOG_ID, audioHash: AUDIO_HASH });
  check(
    "unpublishing takes the reader off the transcript",
    (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "withheld"
  );
  check(
    "unpublishing deliberately leaves search alone",
    (await resolveSearchTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "publication"
  );

  const republished = await publishTranscript({
    catalogId: CATALOG_ID,
    audioHash: AUDIO_HASH,
    userId: alice.id,
  }, deps);
  check(
    "republishing unchanged text reuses the snapshot",
    republished.reused && republished.publicationId === published.publicationId,
    republished
  );

  // --- archive and recreate ------------------------------------------------
  console.log("\narchiving a mis-started workspace");

  let archiveRefused: string | null = null;
  try {
    await archiveWorkspace({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
      reason: "wrong source",
    });
  } catch (error) {
    archiveRefused = (error as { code?: string }).code ?? null;
  }
  check(
    "archiving refuses a workspace that still backs a publication",
    archiveRefused === "PUBLICATION_ACTIVE",
    archiveRefused
  );

  // A withdrawal interrupted after its intent commits must leave search on the
  // correction the reader has already released, and must be resumable.
  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: {
      searchPublicationId: null,
      readerPublicationId: null,
      searchWithdrawalId: randomUUID(),
    },
  });
  check(
    "an interrupted withdrawal leaves search ahead of the reader",
    (await readIndexPointer(CATALOG_ID, AUDIO_HASH)) !== null &&
      (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "withheld"
  );

  let publishDuringWithdrawal: string | null = null;
  try {
    await publishTranscript({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
    }, deps);
  } catch (error) {
    publishDuringWithdrawal = (error as { code?: string }).code ?? null;
  }
  check(
    "an unfinished withdrawal blocks publication",
    publishDuringWithdrawal === "PUBLICATION_IN_FLIGHT",
    publishDuringWithdrawal
  );

  let archiveDuringWithdrawal: string | null = null;
  try {
    await archiveWorkspace({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
      reason: "must wait for withdrawal",
    });
  } catch (error) {
    archiveDuringWithdrawal = (error as { code?: string }).code ?? null;
  }
  check(
    "an unfinished withdrawal blocks archive and workspace replacement",
    archiveDuringWithdrawal === "WORKSPACE_LOCKED",
    archiveDuringWithdrawal
  );

  // Concurrent retries join the same generation; neither can outlive it and
  // delete a pointer written after that generation completed.
  await Promise.all([
    withdrawFromSearch(CATALOG_ID, AUDIO_HASH, deps),
    withdrawFromSearch(CATALOG_ID, AUDIO_HASH, deps),
  ]);
  const pendingWithdrawal = await prisma.transcriptWorkspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { searchWithdrawalId: true, searchWithdrawalJobId: true },
  });
  check(
    "withdrawal keeps its intent until search confirms it",
    pendingWithdrawal.searchWithdrawalId !== null &&
      pendingWithdrawal.searchWithdrawalJobId !== null &&
      indexSyncRequests.some(
        (request) =>
          request.operation === "withdraw" && request.operationToken === pendingWithdrawal.searchWithdrawalId
      ),
    { pendingWithdrawal, indexSyncRequests }
  );
  check(
    "a stale withdrawal report is ignored",
    (
      await completeIndexSync(
        {
          catalogId: CATALOG_ID,
          audioHash: AUDIO_HASH,
          operation: "withdraw",
          operationToken: randomUUID(),
          status: "SUCCEEDED",
          transcriptPath: machineIndexedPath,
        },
        deps
      )
    ).outcome === "ignored"
  );
  const withdrawn = await completeIndexSync(
    {
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      operation: "withdraw",
      operationToken: pendingWithdrawal.searchWithdrawalId!,
      status: "SUCCEEDED",
      transcriptFingerprint: "m".repeat(64),
      transcriptPath: machineIndexedPath,
    },
    deps
  );
  check("withdrawal completes once search holds the machine text", withdrawn.outcome === "withdrawn", withdrawn);
  check(
    "resuming clears the intent",
    (
      await prisma.transcriptWorkspace.findUniqueOrThrow({
        where: { id: workspace.id },
        select: { searchWithdrawalId: true },
      })
    ).searchWithdrawalId === null
  );
  check(
    "withdrawing from search returns both sides to the machine transcript",
    (await resolveSearchTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "machine" &&
      (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "withheld"
  );
  check("withdrawing removes the index pointer", (await readIndexPointer(CATALOG_ID, AUDIO_HASH)) === null);

  let reasonRequired = false;
  try {
    await archiveWorkspace({
      catalogId: CATALOG_ID,
      audioHash: AUDIO_HASH,
      userId: alice.id,
      reason: "   ",
    });
  } catch (error) {
    reasonRequired = (error as { code?: string }).code === "EMPTY_TEXT";
  }
  check("archiving needs a reason", reasonRequired);

  const archived = await archiveWorkspace({
    catalogId: CATALOG_ID,
    audioHash: AUDIO_HASH,
    userId: alice.id,
    reason: "wrong source was frozen",
  });
  check("the workspace is archived, not deleted", archived.status === "ARCHIVED", archived.status);
  check(
    "its history survives",
    (await prisma.transcriptSpanDecision.count({
      where: { workspaceId: archived.id },
    })) > 0
  );

  const restarted = await startWorkspace({
    catalogId: CATALOG_ID,
    audioHash: AUDIO_HASH,
    transcriptsPath: path.join(transcriptsDir, `transcripts_${CATALOG_ID}`),
    userId: bob.id,
  });
  check("a new workspace can be started for the same recording", restarted.id !== archived.id);
  check(
    "the archived workspace is still there for audit",
    (await prisma.transcriptWorkspace.count({
      where: { audioHash: AUDIO_HASH },
    })) === 2
  );

  // --- deleting a participant ---------------------------------------------
  console.log("\ndeleting a participant");

  // Give the account being deleted a revision of its own, so the check below
  // is about attribution surviving rather than about an absent author.
  const bobSpan = (await listSpans(restarted.id)).spans[0];
  const bobRevision = await saveAndApprove({
    workspaceId: restarted.id,
    spanId: bobSpan.id,
    userId: bob.id,
    expectedRevisionId: bobSpan.revisionId,
    text: "bob wrote this",
  });

  const beforeDeletion = (await listSpans(workspace.id)).spans[0];
  await prisma.user.delete({ where: { id: bob.id } });
  const afterDeletion = (await listSpans(workspace.id)).spans[0];

  check(
    "a deleted participant's approval survives",
    afterDeletion.state === beforeDeletion.state && afterDeletion.state === "done",
    { before: beforeDeletion.state, after: afterDeletion.state }
  );
  check(
    "two distinct people still count as two",
    afterDeletion.approverIds.length === 2,
    afterDeletion.approverIds.length
  );
  check(
    "the decision row is kept, with the account reference cleared",
    (await prisma.transcriptSpanDecision.count({
      where: { actorKey: bob.id, userId: null },
    })) > 0
  );
  check(
    "a deleted editor's revision still names them",
    (await prisma.transcriptSpanRevision.count({
      where: { id: bobRevision.revisionId, actorKey: bob.id, authorId: null },
    })) === 1
  );
  check(
    "span history still attributes that revision to the deleted account",
    (await listSpanHistory(restarted.id, bobSpan.id)).some(
      (entry) => entry.kind === "revision" && entry.userId === bob.id
    )
  );

  // --- span states, straight from the database -----------------------------
  console.log("\nspan states");
  {
    const { loadSpanSummaries } = await import("@/lib/correction/span-summaries");
    const {
      findNextOpenSpan,
      listFilteredSpanIds,
      loadSpanStrip,
      loadWorkspaceAggregates,
    } = await import("@/lib/correction/span-queries");

    const stateWorkspace = await prisma.transcriptWorkspace.create({
      data: {
        workflowGroupId: CATALOG_ID,
        audioHash: createHash("sha256").update(randomUUID()).digest("hex"),
        sourceBackend: BACKEND,
        sourceFingerprint: "0".repeat(64),
      },
    });

    // One span per scenario, each ten seconds long, so the aggregate checks
    // below can count audio as well as spans.
    let nextOrdinal = 0;
    async function makeSpan(text = "text") {
      const ordinal = nextOrdinal++;
      const span = await prisma.transcriptSpan.create({
        data: {
          workspaceId: stateWorkspace.id,
          ordinal,
          startSeconds: ordinal * 10,
          endSeconds: ordinal * 10 + 10,
          originalText: text,
          originalTextHash: createHash("sha256").update(text).digest("hex"),
        },
      });
      const revision = await newRevision(span.id, text, null);
      return { span, revision };
    }
    async function newRevision(spanId: string, text: string, previousRevisionId: string | null) {
      const revision = await prisma.transcriptSpanRevision.create({
        data: {
          workspaceId: stateWorkspace.id,
          spanId,
          text,
          textHash: createHash("sha256").update(text).digest("hex"),
          previousRevisionId,
        },
      });
      await prisma.transcriptSpan.update({ where: { id: spanId }, data: { currentRevisionId: revision.id } });
      return revision;
    }
    async function decide(
      spanId: string,
      revisionId: string,
      actor: string,
      kind: "APPROVE" | "DISAPPROVE" | "WITHDRAW"
    ) {
      await prisma.transcriptSpanDecision.create({
        data: { workspaceId: stateWorkspace.id, spanId, revisionId, actorKey: actor, kind },
      });
    }

    const untouched = await makeSpan();
    const oneApproval = await makeSpan();
    await decide(oneApproval.span.id, oneApproval.revision.id, "alice", "APPROVE");

    const twoApprovals = await makeSpan();
    await decide(twoApprovals.span.id, twoApprovals.revision.id, "alice", "APPROVE");
    await decide(twoApprovals.span.id, twoApprovals.revision.id, "bob", "APPROVE");

    const sameTwice = await makeSpan();
    await decide(sameTwice.span.id, sameTwice.revision.id, "alice", "APPROVE");
    await decide(sameTwice.span.id, sameTwice.revision.id, "alice", "APPROVE");

    const outvoted = await makeSpan();
    for (const actor of ["alice", "bob", "carol"]) {
      await decide(outvoted.span.id, outvoted.revision.id, actor, "APPROVE");
    }
    await decide(outvoted.span.id, outvoted.revision.id, "dave", "DISAPPROVE");

    const changedMind = await makeSpan();
    await decide(changedMind.span.id, changedMind.revision.id, "alice", "DISAPPROVE");
    await decide(changedMind.span.id, changedMind.revision.id, "alice", "APPROVE");
    await decide(changedMind.span.id, changedMind.revision.id, "bob", "APPROVE");

    const withdrawn = await makeSpan();
    await decide(withdrawn.span.id, withdrawn.revision.id, "alice", "APPROVE");
    await decide(withdrawn.span.id, withdrawn.revision.id, "bob", "DISAPPROVE");
    await decide(withdrawn.span.id, withdrawn.revision.id, "bob", "WITHDRAW");

    // The same instant for both rows: the write order, not the clock, decides.
    const tied = await makeSpan();
    const instant = new Date();
    await decide(tied.span.id, tied.revision.id, "alice", "APPROVE");
    await decide(tied.span.id, tied.revision.id, "bob", "APPROVE");
    await decide(tied.span.id, tied.revision.id, "bob", "WITHDRAW");
    await prisma.transcriptSpanDecision.updateMany({
      where: { spanId: tied.span.id },
      data: { createdAt: instant },
    });

    // Approved twice, then edited, then edited back to the original wording.
    const revived = await makeSpan("wording");
    await decide(revived.span.id, revived.revision.id, "alice", "APPROVE");
    await decide(revived.span.id, revived.revision.id, "bob", "APPROVE");
    const edited = await newRevision(revived.span.id, "other wording", revived.revision.id);
    await newRevision(revived.span.id, "wording", edited.id);

    const states = new Map(
      (await loadSpanSummaries(stateWorkspace.id)).map((row) => [row.id, row.summary])
    );
    const stateOf = (spanId: string) => states.get(spanId)?.state;

    check("a span nobody decided on is not reviewed", stateOf(untouched.span.id) === "not_reviewed");
    check(
      "one approval needs a second",
      stateOf(oneApproval.span.id) === "needs_second_approval" &&
        states.get(oneApproval.span.id)?.approverIds.join() === "alice"
    );
    check("two distinct people finish a span", stateOf(twoApprovals.span.id) === "done");
    check(
      "the same person twice counts once",
      stateOf(sameTwice.span.id) === "needs_second_approval" &&
        states.get(sameTwice.span.id)?.approverIds.length === 1
    );
    check(
      "an objection is never outvoted",
      stateOf(outvoted.span.id) === "needs_attention" && states.get(outvoted.span.id)?.isDone === false
    );
    check(
      "a person's latest decision replaces their earlier one",
      stateOf(changedMind.span.id) === "done" && states.get(changedMind.span.id)?.disapproverIds.length === 0
    );
    check(
      "a withdrawal leaves no effective decision",
      stateOf(withdrawn.span.id) === "needs_second_approval" &&
        states.get(withdrawn.span.id)?.disapproverIds.length === 0
    );
    check(
      "the write order breaks a timestamp tie",
      stateOf(tied.span.id) === "needs_second_approval" &&
        states.get(tied.span.id)?.approverIds.join() === "alice"
    );
    check(
      "old approvals never revive after the wording returns",
      stateOf(revived.span.id) === "not_reviewed"
    );

    // The revision override answers for the revision a replayed command named.
    const replayed = await loadSpanDecisionSummariesFor(revived.span.id, revived.revision.id);
    check("a named revision keeps the decisions it was given", replayed === "done", replayed);

    // Aggregates, filters, the strip and the next-open walk read the same states.
    const aggregate = (await loadWorkspaceAggregates([stateWorkspace.id], "alice")).get(stateWorkspace.id);
    check("the aggregate counts every span", aggregate?.spanCount === nextOrdinal, aggregate?.spanCount);
    check(
      "the aggregate counts states",
      aggregate?.counts.done === 2 &&
        aggregate.counts.needs_attention === 1 &&
        aggregate.counts.needs_second_approval === 4 &&
        aggregate.counts.not_reviewed === 2,
      aggregate?.counts
    );
    check(
      "the aggregate counts audio, not just spans",
      aggregate?.seconds.done === 20 && aggregate.totalSeconds === nextOrdinal * 10,
      aggregate?.seconds
    );
    check(
      "the aggregate knows this person's share",
      aggregate?.mine.approved === 7 &&
        aggregate.mine.disapproved === 0 &&
        aggregate.mine.waitingOnOthers === 4 &&
        aggregate.mine.open === 2,
      aggregate?.mine
    );

    const bobAggregate = (await loadWorkspaceAggregates([stateWorkspace.id], "bob")).get(stateWorkspace.id);
    check("a different person sees their own share", bobAggregate?.mine.approved === 3, bobAggregate?.mine);

    const mineOpen = await listFilteredSpanIds(stateWorkspace.id, "alice", "mine_open", { offset: 0, limit: 50 });
    check(
      "the mine-open filter lists what still wants this person",
      mineOpen.total === 2 &&
        mineOpen.ids.includes(untouched.span.id) &&
        mineOpen.ids.includes(revived.span.id),
      mineOpen
    );
    const attention = await listFilteredSpanIds(stateWorkspace.id, "alice", "needs_attention", {
      offset: 0,
      limit: 50,
    });
    check("the attention filter lists the disputed span", attention.ids.join() === outvoted.span.id, attention);
    const pastEnd = await listFilteredSpanIds(stateWorkspace.id, "alice", "not_reviewed", { offset: 50, limit: 50 });
    check("an offset past the end still reports the total", pastEnd.ids.length === 0 && pastEnd.total === 2, pastEnd);

    const next = await findNextOpenSpan(stateWorkspace.id, "alice");
    check("resuming opens the first span that wants this person", next?.spanId === untouched.span.id, next);
    const afterFirst = await findNextOpenSpan(stateWorkspace.id, "alice", untouched.span.ordinal);
    check("next opens the following span that wants this person", afterFirst?.spanId === revived.span.id, afterFirst);
    const wrapped = await findNextOpenSpan(stateWorkspace.id, "alice", revived.span.ordinal);
    check("next wraps round to the start", wrapped?.spanId === untouched.span.id, wrapped);

    const strip = await loadSpanStrip(stateWorkspace.id, "alice");
    check(
      "the strip carries every span in order with this person's marks",
      strip.length === nextOrdinal &&
        strip[0].spanId === untouched.span.id &&
        strip[0].state === "not_reviewed" &&
        strip[1].approvedByMe &&
        strip[4].state === "needs_attention" &&
        !strip[4].disapprovedByMe,
      strip.slice(0, 5)
    );

    async function loadSpanDecisionSummariesFor(spanId: string, revisionId: string) {
      const { loadSpanDecisionSummaries } = await import("@/lib/correction/span-summaries");
      return (await loadSpanDecisionSummaries([spanId], { revisionId })).get(spanId)?.state;
    }
  }

  // --- the catalog overview -------------------------------------------------
  console.log("\nthe catalog overview");
  {
    const { loadCorrectionOverview } = await import("@/lib/correction/overview");

    // A primary recording nobody has started, not yet published to listeners.
    const unstartedHash = createHash("sha256").update(randomUUID()).digest("hex");
    await prisma.catalogEntry.create({
      data: {
        workflowGroupId: CATALOG_ID,
        audioHash: unstartedHash,
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: false,
        durationHms: "01:30:05",
      },
    });
    const unstartedEvent = await prisma.catalogEvent.create({
      data: {
        workflowGroupId: CATALOG_ID,
        locationId: (await prisma.location.findFirstOrThrow({ where: { workflowGroupId: CATALOG_ID } })).id,
        dateYear: 2027,
        title: "Not started yet",
        createdById: alice.id,
        updatedById: alice.id,
      },
    });
    await prisma.catalogEventRecording.create({
      data: { eventId: unstartedEvent.id, workflowGroupId: CATALOG_ID, audioHash: unstartedHash, isPrimary: true },
    });

    const overview = await loadCorrectionOverview({
      catalogId: CATALOG_ID,
      actorKey: alice.id,
      canSeeUnreleased: true,
    });

    const live = overview.workspaces.find((item) => item.recording.audioHash === AUDIO_HASH);
    check("a live workspace is listed with its recording", live?.workspaceId === restarted.id, live?.workspaceId);
    check(
      "an archived workspace is not listed",
      !overview.workspaces.some((item) => item.workspaceId === workspace.id)
    );
    check("a workspace with unfinished spans is in progress", live?.status === "in_progress", live?.status);
    check(
      "the overview reports the same progress as the page",
      live?.progress?.spanCount === 2 && live.progress.totalSeconds === 12,
      live?.progress
    );
    check("this person's share is reported", live?.mine !== null && live?.touchedByMe === false, live?.mine);
    check("the event and place are named", live?.recording.locationName === "Test place", live?.recording);

    const unstarted = overview.notStarted.items.find((item) => item.recording.audioHash === unstartedHash);
    check(
      "a primary recording nobody started is listed as not started",
      unstarted?.status === "not_started" && overview.notStarted.total === 1,
      overview.notStarted
    );
    check("its length comes from the catalog row", unstarted?.recording.durationSeconds === 5405, unstarted?.recording);
    check(
      "a started recording is not offered as not started",
      !overview.notStarted.items.some((item) => item.recording.audioHash === AUDIO_HASH)
    );
    check(
      "the summary counts hours per status",
      overview.summary.byStatus.not_started.count === 1 &&
        overview.summary.byStatus.not_started.seconds === 5405 &&
        overview.summary.byStatus.in_progress.count === overview.workspaces.length &&
        overview.summary.byStatus.in_progress.seconds ===
          overview.workspaces.reduce((sum, item) => sum + item.recording.durationSeconds, 0),
      overview.summary.byStatus
    );

    const limited = await loadCorrectionOverview({
      catalogId: CATALOG_ID,
      actorKey: alice.id,
      canSeeUnreleased: false,
    });
    check(
      "someone who cannot see unreleased material does not see it listed",
      limited.notStarted.total === 0 && limited.workspaces.some((item) => item.recording.audioHash === AUDIO_HASH),
      limited.notStarted
    );

    // Touching the workspace makes it this person's, and makes them the last actor.
    const touchedSpan = (await listSpans(restarted.id)).spans[1];
    await recordDecision({
      workspaceId: restarted.id,
      spanId: touchedSpan.id,
      userId: alice.id,
      expectedRevisionId: touchedSpan.revisionId,
      kind: "APPROVE",
    });
    const touched = (
      await loadCorrectionOverview({ catalogId: CATALOG_ID, actorKey: alice.id, canSeeUnreleased: true })
    ).workspaces.find((item) => item.workspaceId === restarted.id);
    check(
      "acting in a workspace makes it this person's",
      touched?.touchedByMe === true && touched.mine?.approved === 1 && touched.mine.waitingOnOthers === 1,
      touched?.mine
    );
    check("the last actor is named", touched?.lastActivity?.actorName != null, touched?.lastActivity);

    // Publish by hand: a snapshot of the current revisions that readers see.
    const currentSpans = await prisma.transcriptSpan.findMany({
      where: { workspaceId: restarted.id },
      orderBy: { ordinal: "asc" },
      select: { id: true, ordinal: true, currentRevisionId: true },
    });
    const publication = await prisma.transcriptPublication.create({
      data: {
        workspaceId: restarted.id,
        workflowGroupId: CATALOG_ID,
        audioHash: AUDIO_HASH,
        status: "SUCCEEDED",
        spans: {
          create: currentSpans.map((span) => ({
            spanId: span.id,
            revisionId: span.currentRevisionId as string,
            ordinal: span.ordinal,
          })),
        },
      },
    });
    await prisma.transcriptWorkspace.update({
      where: { id: restarted.id },
      data: { readerPublicationId: publication.id },
    });
    const statusNow = async () =>
      (await loadCorrectionOverview({ catalogId: CATALOG_ID, actorKey: alice.id, canSeeUnreleased: true })).workspaces.find(
        (item) => item.workspaceId === restarted.id
      );

    const published = await statusNow();
    check("a snapshot that matches the live text is published", published?.status === "published", published?.status);

    const first = (await listSpans(restarted.id)).spans[0];
    await saveAndApprove({
      workspaceId: restarted.id,
      spanId: first.id,
      userId: alice.id,
      expectedRevisionId: first.revisionId,
      text: "edited after publication",
    });
    const changed = await statusNow();
    check(
      "an edit after publication marks the recording as changed",
      changed?.status === "published_changed" && changed.changedSinceReaderPublication === 1,
      changed?.status
    );

    await prisma.transcriptPublication.update({ where: { id: publication.id }, data: { status: "ACTIVATING" } });
    check("a publication on its way is reported as publishing", (await statusNow())?.status === "publishing");

    await prisma.transcriptWorkspace.update({ where: { id: restarted.id }, data: { readerPublicationId: null } });
    await prisma.transcriptPublication.delete({ where: { id: publication.id } });
  }

  console.log(`\ncorrections root: ${correctionsDir}`);
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);

  // Leave the database as the run found it; the corrections tree is printed
  // above so the Python side can be checked against it. Events and locations
  // restrict deletion of their catalog, so they go first. A cleanup failure
  // must not change what the run reported.
  try {
    await prisma.catalogEvent.deleteMany({
      where: { workflowGroupId: CATALOG_ID },
    });
    await prisma.location.deleteMany({
      where: { workflowGroupId: CATALOG_ID },
    });
    await prisma.workflowGroup.delete({ where: { id: CATALOG_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await prisma.transcriptSpanDecision.deleteMany({
      where: { actorKey: bob.id },
    });
  } catch (error) {
    console.warn("cleanup failed, leaving fixture rows behind:", error);
  }

  await prisma.$disconnect();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
