/**
 * End-to-end smoke check for human transcript correction.
 *
 * The unit tests cover each piece against mocks; this drives the whole path
 * against a real database and a real corrections tree, because the parts most
 * likely to be wrong are the seams — the partial unique indexes, the atomic
 * edit-and-approve, the artifacts the publication job writes and the pointer
 * the Python index build reads.
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
const BACKEND_MODEL = "large-v3@silero_vad_v6";
const BACKEND = `${BACKEND_WORKFLOW}/${BACKEND_MODEL}`;

const machineDir = path.join(
  transcriptsDir,
  `transcripts_${CATALOG_ID}`,
  BACKEND_WORKFLOW,
  BACKEND_MODEL,
  AUDIO_HASH
);
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
        { start: 0, end: 5, text: "Dobry den vsichni.", words: [{ word: "Dobry" }], confidence: 0.7 },
        { start: 5, end: 12, text: "Vitejte na besede.", words: [], confidence: 0.6 },
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
  const { saveAndApprove, recordDecision, listSpanHistory } = await import(
    "@/lib/correction/decision-service"
  );
  const {
    publishTranscript,
    unpublishTranscript,
    getPublicationEligibility,
    withdrawFromSearch,
    reconcilePublication,
    rollbackPublication,
  } = await import("@/lib/correction/publication-service");
  const {
    resolveReaderTranscriptSource,
    resolveSearchTranscriptSource,
    resolveOriginalTranscriptSource,
  } = await import("@/lib/correction/resolve");
  const { readIndexPointer, resolvePublicationFilePath } = await import(
    "@/lib/correction/storage"
  );

  // --- fixture -------------------------------------------------------------
  const alice = await prisma.user.create({
    data: { id: `alice-${randomUUID()}`, email: `alice-${randomUUID()}@example.test`, status: "ACTIVE" },
  });
  const bob = await prisma.user.create({
    data: { id: `bob-${randomUUID()}`, email: `bob-${randomUUID()}@example.test`, status: "ACTIVE" },
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
  const [first, second] = page.spans;
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
      workspaceId: workspace.id, spanId: concurrentSpan.id, userId: alice.id,
      expectedRevisionId: concurrentSpan.revisionId, kind: "APPROVE",
      idempotencyKey: concurrentKey,
    }),
    recordDecision({
      workspaceId: workspace.id, spanId: concurrentSpan.id, userId: alice.id,
      expectedRevisionId: concurrentSpan.revisionId, kind: "APPROVE",
      idempotencyKey: concurrentKey,
    }),
  ]);
  check(
    "simultaneous identical requests both succeed, one as a replay",
    concurrent.every((outcome) => outcome.status === "fulfilled") &&
      concurrent.some(
        (outcome) => outcome.status === "fulfilled" && outcome.value.replayed
      ),
    concurrent.map((o) => (o.status === "fulfilled" ? `ok replayed=${o.value.replayed}` : `rejected ${(o.reason as { code?: string }).code}`))
  );

  // The same action on a later revision is a different command.
  const staleKey = randomUUID();
  const revisionSpan = (await listSpans(workspace.id)).spans[1];
  await recordDecision({
    workspaceId: workspace.id, spanId: revisionSpan.id, userId: bob.id,
    expectedRevisionId: revisionSpan.revisionId, kind: "APPROVE",
    idempotencyKey: staleKey,
  });
  await saveAndApprove({
    workspaceId: workspace.id, spanId: revisionSpan.id, userId: alice.id,
    expectedRevisionId: revisionSpan.revisionId, text: "moved on",
  });
  let staleRevisionRefused: string | null = null;
  try {
    const moved = (await listSpans(workspace.id)).spans[1];
    await recordDecision({
      workspaceId: workspace.id, spanId: moved.id, userId: bob.id,
      expectedRevisionId: moved.revisionId, kind: "APPROVE",
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
    await publishTranscript({ catalogId: CATALOG_ID, audioHash: AUDIO_HASH, userId: alice.id });
  } catch (error) {
    refusedWhileBlocked =
      (error as { code?: string }).code === "NOT_ELIGIBLE_FOR_PUBLICATION";
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
    publishTranscript({ catalogId: CATALOG_ID, audioHash: AUDIO_HASH, userId: alice.id }),
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
  check(
    "a disputed span is never inside a published snapshot",
    !disputedInSnapshot,
    { publishWon, decisionWon }
  );

  // Put the span back into an approved state for the rest of the run.
  if (decisionWon) {
    const current = (await listSpans(workspace.id)).spans[0];
    await recordDecision({
      workspaceId: workspace.id, spanId: current.id, userId: bob.id,
      expectedRevisionId: current.revisionId, kind: "WITHDRAW",
    });
    await recordDecision({
      workspaceId: workspace.id, spanId: current.id, userId: bob.id,
      expectedRevisionId: current.revisionId, kind: "APPROVE",
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
  const published = await publishTranscript({
    catalogId: CATALOG_ID,
    audioHash: AUDIO_HASH,
    userId: alice.id,
  });
  check("the publication job succeeds", published.status === "SUCCEEDED", published);

  for (const format of ["json", "txt", "srt", "vtt"] as const) {
    const artifact = resolvePublicationFilePath(
      CATALOG_ID,
      workspace.id,
      published.publicationId,
      format
    );
    check(`renders transcript.${format}`, fs.existsSync(artifact), artifact);
  }

  const document = JSON.parse(
    fs.readFileSync(
      resolvePublicationFilePath(CATALOG_ID, workspace.id, published.publicationId, "json"),
      "utf-8"
    )
  );
  check("published JSON carries the corrected text", document.meta.transcript_text.includes("Dobrý den"), document.meta.transcript_text);
  check("published JSON keeps the honest backend", document.meta.backend === "faster-whisper");
  check("published JSON omits num_words", !("num_words" in document.meta));
  check("published segments are text-only", document.segments.every((s: { words: unknown[]; confidence: null }) => s.words.length === 0 && s.confidence === null));
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
  const otherDir = path.join(
    transcriptsDir, `transcripts_${CATALOG_ID}`, BACKEND_WORKFLOW, BACKEND_MODEL, otherHash
  );
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherDir, "transcript.json"),
    JSON.stringify({
      meta: {
        backend: "faster-whisper", model: "large-v3",
        audio_filepath: `/audio/${otherHash}.wav`, duration: 4,
        generation_params: {},
      },
      segments: [{ start: 0, end: 4, text: "Jina nahravka." }],
    })
  );
  await prisma.catalogEntry.create({
    data: {
      workflowGroupId: CATALOG_ID, audioHash: otherHash, hasArchived: true,
      hasMetadata: true, isActionable: true, isPublished: true,
    },
  });
  const otherEvent = await prisma.catalogEvent.create({
    data: {
      workflowGroupId: CATALOG_ID, locationId: location.id, dateYear: 2026,
      sessionIndex: 2, createdById: alice.id, updatedById: alice.id,
    },
  });
  await prisma.catalogEventRecording.create({
    data: {
      eventId: otherEvent.id, workflowGroupId: CATALOG_ID,
      audioHash: otherHash, isPrimary: true,
    },
  });
  const otherWorkspace = await startWorkspace({
    catalogId: CATALOG_ID, audioHash: otherHash,
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
    await rollbackPublication(published.publicationId, foreignWorkspaceId);
  } catch (error) {
    rollbackRefused = (error as { code?: string }).code === "PUBLICATION_NOT_FOUND";
  }
  check("rolling back refuses a publication from another workspace", rollbackRefused);

  // A rollback is one-shot. Replaying an old one must not reach past a
  // publication that has succeeded since and take its pointer away.
  let staleRollbackTouchedPointer = false;
  const pointerBefore = await readIndexPointer(CATALOG_ID, AUDIO_HASH);
  await prisma.transcriptPublication.update({
    where: { id: published.publicationId },
    data: { status: "ROLLED_BACK" },
  });
  await rollbackPublication(published.publicationId, workspace.id);
  const pointerAfter = await readIndexPointer(CATALOG_ID, AUDIO_HASH);
  staleRollbackTouchedPointer =
    JSON.stringify(pointerBefore) !== JSON.stringify(pointerAfter);
  await prisma.transcriptPublication.update({
    where: { id: published.publicationId },
    data: { status: "SUCCEEDED" },
  });
  check(
    "replaying a finished rollback leaves the pointer alone",
    !staleRollbackTouchedPointer
  );

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
  });
  check("republishing unchanged text reuses the snapshot", republished.reused && republished.publicationId === published.publicationId, republished);

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
  check("archiving refuses a workspace that still backs a publication", archiveRefused === "PUBLICATION_ACTIVE", archiveRefused);

  // A withdrawal interrupted after its intent commits must leave search on the
  // correction the reader has already released, and must be resumable.
  await prisma.transcriptWorkspace.update({
    where: { id: workspace.id },
    data: {
      searchPublicationId: null,
      readerPublicationId: null,
      searchWithdrawalAt: new Date(),
    },
  });
  check(
    "an interrupted withdrawal leaves search ahead of the reader",
    (await readIndexPointer(CATALOG_ID, AUDIO_HASH)) !== null &&
      (await resolveReaderTranscriptSource(CATALOG_ID, AUDIO_HASH)).kind === "withheld"
  );

  let publishDuringWithdrawal: string | null = null;
  try {
    await publishTranscript({ catalogId: CATALOG_ID, audioHash: AUDIO_HASH, userId: alice.id });
  } catch (error) {
    publishDuringWithdrawal = (error as { code?: string }).code ?? null;
  }
  check(
    "an unfinished withdrawal blocks publication",
    publishDuringWithdrawal === "PUBLICATION_IN_FLIGHT",
    publishDuringWithdrawal
  );

  // Resuming finishes it.
  await withdrawFromSearch(CATALOG_ID, AUDIO_HASH);
  check(
    "resuming clears the intent",
    (await prisma.transcriptWorkspace.findUniqueOrThrow({
      where: { id: workspace.id },
      select: { searchWithdrawalAt: true },
    })).searchWithdrawalAt === null
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
    (await prisma.transcriptSpanDecision.count({ where: { workspaceId: archived.id } })) > 0
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
    (await prisma.transcriptWorkspace.count({ where: { audioHash: AUDIO_HASH } })) === 2
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

  console.log(`\ncorrections root: ${correctionsDir}`);
  console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\n${failures.length} CHECK(S) FAILED`);

  // Leave the database as the run found it; the corrections tree is printed
  // above so the Python side can be checked against it. Events and locations
  // restrict deletion of their catalog, so they go first. A cleanup failure
  // must not change what the run reported.
  try {
    await prisma.catalogEvent.deleteMany({ where: { workflowGroupId: CATALOG_ID } });
    await prisma.location.deleteMany({ where: { workflowGroupId: CATALOG_ID } });
    await prisma.workflowGroup.delete({ where: { id: CATALOG_ID } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
    await prisma.transcriptSpanDecision.deleteMany({ where: { actorKey: bob.id } });
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
