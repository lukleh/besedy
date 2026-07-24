/**
 * Prisma Test Seed Script
 *
 * Seeds the database with test data for E2E testing.
 *
 * Creates:
 * - Superadmin user (for creating pending admissions and as test user)
 * - Special state users directly (admin, pending, blocked - need specific properties)
 * - Pending admissions for normal users
 * - A test WorkflowGroup with fixture paths
 * - Recorders and Locations for filtering
 *
 * This approach keeps deterministic user states for integration tests.
 *
 * Usage:
 *   DATABASE_URL=postgresql://besedy_test:besedy_test@localhost:5434/besedy_test tsx prisma/seed-test.ts
 */

import { PrismaClient, UserStatus, AccessLevel } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  TEST_AUDIO_FILES,
  TEST_CATALOG_ID,
  TEST_EVENTS,
  TEST_LOCATIONS,
  TEST_RECORDERS,
  TEST_USERS,
} from "./test-data";
import { syncSeedPendingAdmissions } from "./seed-pending-admissions";

// Users created directly (need specific properties that cannot be set via pending admission)
const DIRECT_USERS: Array<{
  email: string;
  name: string;
  isSuperadmin: boolean;
  isAdmin: boolean;
  status: UserStatus;
  catalogAccess?: AccessLevel;
}> = [
  // Superadmin - needed as inviter for other users
  { email: TEST_USERS.superadmin.email, name: TEST_USERS.superadmin.name, isSuperadmin: true, isAdmin: false, status: "ACTIVE" },
  // Admin - needs isAdmin=true (cannot be set via pending admission)
  { email: TEST_USERS.admin.email, name: TEST_USERS.admin.name, isSuperadmin: false, isAdmin: true, status: "ACTIVE" },
  // Pending - needs to stay PENDING (activatePendingUser would change it)
  { email: TEST_USERS.pending.email, name: TEST_USERS.pending.name, isSuperadmin: false, isAdmin: false, status: "PENDING" },
  // Blocked - needs status=BLOCKED (cannot be set via pending admission)
  { email: TEST_USERS.blocked.email, name: TEST_USERS.blocked.name, isSuperadmin: false, isAdmin: false, status: "BLOCKED" },
  // Mutation - needs to exist for tests that search for users to grant access
  { email: TEST_USERS.mutation.email, name: TEST_USERS.mutation.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE" },
  // Catalog access users - created directly to support devLogin API testing
  { email: TEST_USERS.owner.email, name: TEST_USERS.owner.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE", catalogAccess: "OWNER" },
  { email: TEST_USERS.editor.email, name: TEST_USERS.editor.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE", catalogAccess: "EDITOR" },
  { email: TEST_USERS.member.email, name: TEST_USERS.member.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE", catalogAccess: "MEMBER" },
  { email: TEST_USERS.viewer.email, name: TEST_USERS.viewer.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE", catalogAccess: "VIEWER" },
  { email: TEST_USERS.listener.email, name: TEST_USERS.listener.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE", catalogAccess: "LISTENER" },
  { email: TEST_USERS.noaccess.email, name: TEST_USERS.noaccess.name, isSuperadmin: false, isAdmin: false, status: "ACTIVE" },
];

// Pending admissions to keep allowlist workflows testable
const INVITED_USERS = [
  { email: TEST_USERS.owner.email, name: TEST_USERS.owner.name, catalogAccess: "OWNER" as AccessLevel },
  { email: TEST_USERS.editor.email, name: TEST_USERS.editor.name, catalogAccess: "EDITOR" as AccessLevel },
  { email: TEST_USERS.member.email, name: TEST_USERS.member.name, catalogAccess: "MEMBER" as AccessLevel },
  { email: TEST_USERS.viewer.email, name: TEST_USERS.viewer.name, catalogAccess: "VIEWER" as AccessLevel },
  { email: TEST_USERS.listener.email, name: TEST_USERS.listener.name, catalogAccess: "LISTENER" as AccessLevel },
  { email: TEST_USERS.noaccess.email, name: TEST_USERS.noaccess.name },
];

// Test workflow group configuration
// Paths must match the Docker volume mounts in docker-compose.yml
// Fixtures are mounted at /data/text/ from tests/e2e/fixtures/
const TEST_WORKFLOW_GROUP = {
  id: TEST_CATALOG_ID,
  archivedCatalogPath: "/data/text/audio_catalog_test_archived.csv",
  metadataCatalogPath: "/data/text/audio_catalog_test.csv",
  duplicatesCatalogPath: "/data/text/audio_catalog_test_duplicates.csv",
  transcriptsPath: "/data/text/transcripts_test",
  isDefault: true,
  isActive: true,
};

// Test recorders (schema only has name field)
const SEEDED_RECORDERS = TEST_RECORDERS.map((name) => ({ name }));

// Test locations (schema only has name field)
const SEEDED_LOCATIONS = TEST_LOCATIONS.map((name) => ({ name }));

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  console.log("Connecting to database...");
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("\n=== Seeding E2E Test Data ===\n");

    // 1. Create workflow group first (needed for catalog access)
    console.log("[1/9] Creating workflow group...");
    const workflowGroup = await prisma.workflowGroup.upsert({
      where: { id: TEST_WORKFLOW_GROUP.id },
      update: TEST_WORKFLOW_GROUP,
      create: TEST_WORKFLOW_GROUP,
    });
    console.log(`  ✓ ${workflowGroup.id}`);

    // 2. Create special state users directly
    console.log("\n[2/9] Creating special state users (direct)...");
    const createdUsers: Record<string, string> = {};

    for (const userData of DIRECT_USERS) {
      const user = await prisma.user.upsert({
        where: { email: userData.email },
        update: {
          name: userData.name,
          isSuperadmin: userData.isSuperadmin,
          isAdmin: userData.isAdmin,
          status: userData.status,
        },
        create: {
          email: userData.email,
          name: userData.name,
          emailVerified: true,
          isSuperadmin: userData.isSuperadmin,
          isAdmin: userData.isAdmin,
          status: userData.status,
          activatedAt: userData.status === "ACTIVE" ? new Date() : null,
        },
      });
      createdUsers[userData.email] = user.id;

      // Create catalog access for users with catalogAccess defined
      if (userData.catalogAccess) {
        await prisma.catalogAccess.upsert({
          where: {
            userId_catalogId: {
              userId: user.id,
              catalogId: workflowGroup.id,
            },
          },
          update: {
            accessLevel: userData.catalogAccess,
          },
          create: {
            userId: user.id,
            catalogId: workflowGroup.id,
            accessLevel: userData.catalogAccess,
            grantedById: user.id, // Self-granted for test setup
          },
        });
      }

      const flags = [
        userData.isSuperadmin && "superadmin",
        userData.isAdmin && "admin",
        userData.status !== "ACTIVE" && userData.status,
        userData.catalogAccess,
      ].filter(Boolean).join(", ");
      console.log(`  ✓ ${userData.email}${flags ? ` (${flags})` : ""}`);
    }

    const superadminId = createdUsers[TEST_USERS.superadmin.email];

    // 3. Create pending admissions for normal users
    console.log("\n[3/9] Creating pending admissions for normal users...");
    for (const userData of INVITED_USERS) {
      // Skip if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: userData.email },
      });
      if (existingUser) {
        createdUsers[userData.email] = existingUser.id;
        console.log(`  - ${userData.email} (user exists)`);
        continue;
      }

      await syncSeedPendingAdmissions(prisma, {
        email: userData.email,
        createdById: superadminId,
        createdAt: new Date(),
        catalogId: userData.catalogAccess ? workflowGroup.id : null,
        accessLevel: userData.catalogAccess || null,
        notes: `E2E test user: ${userData.name}`,
      });
      console.log(`  ✓ ${userData.email}${userData.catalogAccess ? ` (${userData.catalogAccess})` : ""}`);
    }

    // 4. Create recorders
    console.log("\n[4/9] Creating recorders...");
    for (const recorder of SEEDED_RECORDERS) {
      await prisma.recorder.upsert({
        where: { name: recorder.name },
        update: recorder,
        create: recorder,
      });
      console.log(`  ✓ ${recorder.name}`);
    }

    // 5. Create locations
    console.log("\n[5/9] Creating locations...");
    for (const location of SEEDED_LOCATIONS) {
      await prisma.location.upsert({
        where: { name: location.name },
        update: location,
        create: location,
      });
      console.log(`  ✓ ${location.name}`);
    }

    // 6. Create audio metadata
    console.log("\n[6/9] Creating audio metadata...");
    const recorderA = await prisma.recorder.findUnique({ where: { name: "Recorder A" } });
    const recorderB = await prisma.recorder.findUnique({ where: { name: "Recorder B" } });
    const locationX = await prisma.location.findUnique({ where: { name: "Location X" } });
    const locationY = await prisma.location.findUnique({ where: { name: "Location Y" } });

    for (let i = 0; i < TEST_AUDIO_FILES.length; i++) {
      const file = TEST_AUDIO_FILES[i];
      const hash = file.hash;
      const recorderId = i % 2 === 0 ? recorderA?.id : recorderB?.id;
      const locationId = i % 2 === 0 ? locationX?.id : locationY?.id;
      const dateYear = i === 2 ? 2023 : 2024;

      await prisma.audioMetadata.upsert({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: TEST_WORKFLOW_GROUP.id,
            audioHash: hash,
          },
        },
        update: {
          recorderId,
          locationId,
          dateYear,
          part: (i % 3) + 1,
        },
        create: {
          workflowGroupId: TEST_WORKFLOW_GROUP.id,
          audioHash: hash,
          recorderId,
          locationId,
          dateYear,
          part: (i % 3) + 1,
        },
      });
      console.log(`  ✓ ${file.shortHash}`);
    }

    // 7. Seed catalog serving rows so event attach/unassigned E2E paths are deterministic
    console.log("\n[7/9] Creating catalog serving rows...");

    const sourceRows = [
      { title: "Test Recording One", artist: "Recorder A", album: "Test Album", date: "2024" },
      { title: "Long Recording", artist: "Recorder B", album: "Test Album", date: "2024" },
      { title: "Short Clip", artist: "Recorder A", album: "Clips", date: "2023" },
      { title: "Extended Session", artist: "Recorder B", album: "Sessions", date: "2024" },
      { title: "Quick Note", artist: "Recorder A", album: "Notes", date: "2024" },
    ];

    let catalogEntryCount = 0;
    for (let i = 0; i < TEST_AUDIO_FILES.length; i++) {
      const file = TEST_AUDIO_FILES[i];
      const source = sourceRows[i];

      await prisma.catalogEntry.upsert({
        where: {
          workflowGroupId_audioHash: {
            workflowGroupId: TEST_WORKFLOW_GROUP.id,
            audioHash: file.hash,
          },
        },
        update: {
          compressedPath: `/data/audio/compressed/${file.hash}.webm`,
          originalPath: `/data/audio/${file.filename}`,
          filename: file.filename,
          scanRoot: "/data/audio",
          durationHms: formatDuration(file.duration),
          sourceTitle: source.title,
          sourceArtist: source.artist,
          sourceAlbum: source.album,
          sourceDate: source.date,
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          duplicateCount: file.shortHash === "ab00002def" ? 2 : 0,
        },
        create: {
          workflowGroupId: TEST_WORKFLOW_GROUP.id,
          audioHash: file.hash,
          compressedPath: `/data/audio/compressed/${file.hash}.webm`,
          originalPath: `/data/audio/${file.filename}`,
          filename: file.filename,
          scanRoot: "/data/audio",
          durationHms: formatDuration(file.duration),
          sourceTitle: source.title,
          sourceArtist: source.artist,
          sourceAlbum: source.album,
          sourceDate: source.date,
          detailsPayloadVersion: 1,
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          duplicateCount: file.shortHash === "ab00002def" ? 2 : 0,
        },
      });
      catalogEntryCount += 1;
    }

    await prisma.catalogDuplicate.deleteMany({
      where: { workflowGroupId: TEST_WORKFLOW_GROUP.id },
    });
    await prisma.catalogDuplicate.createMany({
      data: [
        {
          workflowGroupId: TEST_WORKFLOW_GROUP.id,
          audioHash: TEST_AUDIO_FILES[1].hash,
          originalPath: `/data/audio/${TEST_AUDIO_FILES[1].filename}`,
          duplicatePath: `/data/audio/backup/${TEST_AUDIO_FILES[1].filename}`,
          duplicatePayloadVersion: 1,
        },
        {
          workflowGroupId: TEST_WORKFLOW_GROUP.id,
          audioHash: TEST_AUDIO_FILES[1].hash,
          originalPath: `/data/audio/${TEST_AUDIO_FILES[1].filename}`,
          duplicatePath: `/data/audio/archive/${TEST_AUDIO_FILES[1].filename}`,
          duplicatePayloadVersion: 1,
        },
      ],
    });

    console.log(`  ✓ Catalog entries: ${catalogEntryCount}`);
    console.log("  ✓ Catalog duplicates: 2");

    // 8. Create seeded catalog events for Events E2E coverage
    console.log("\n[8/9] Creating catalog events...");

    const adminUserId = createdUsers[TEST_USERS.admin.email];
    if (!adminUserId) {
      throw new Error("Admin user missing; cannot seed catalog events");
    }

    // Keep events deterministic across reruns.
    await prisma.catalogEventRecording.deleteMany({
      where: { workflowGroupId: TEST_WORKFLOW_GROUP.id },
    });
    await prisma.catalogEvent.deleteMany({
      where: { workflowGroupId: TEST_WORKFLOW_GROUP.id },
    });

    const audioHashByShortHash = new Map(
      TEST_AUDIO_FILES.map((file) => [file.shortHash, file.hash])
    );
    const locationIdByName = new Map(
      [locationX, locationY]
        .filter((location): location is NonNullable<typeof location> => location !== null)
        .map((location) => [location.name, location.id])
    );

    let eventRecordingCount = 0;
    const eventIdByTitle = new Map<string, number>();

    for (const eventSpec of TEST_EVENTS) {
      const locationId = locationIdByName.get(eventSpec.location);
      if (!locationId) {
        throw new Error(`Location not found for event seed: ${eventSpec.location}`);
      }

      const event = await prisma.catalogEvent.create({
        data: {
          workflowGroupId: TEST_WORKFLOW_GROUP.id,
          title: eventSpec.title,
          locationId,
          dateYear: eventSpec.dateYear,
          dateMonth: eventSpec.dateMonth,
          dateDay: eventSpec.dateDay,
          description: eventSpec.description ?? null,
          released: eventSpec.released,
          createdById: adminUserId,
          updatedById: adminUserId,
        },
      });
      eventIdByTitle.set(eventSpec.title, event.id);

      if (eventSpec.recordings.length > 0) {
        const rows = eventSpec.recordings.map((shortHash) => {
          const audioHash = audioHashByShortHash.get(shortHash);
          if (!audioHash) {
            throw new Error(`Unknown short hash in event seed: ${shortHash}`);
          }
          return {
            eventId: event.id,
            workflowGroupId: TEST_WORKFLOW_GROUP.id,
            audioHash,
            isPrimary: eventSpec.primaryRecording === shortHash,
          };
        });

        await prisma.catalogEventRecording.createMany({ data: rows });
        eventRecordingCount += rows.length;
      }

      console.log(
        `  ✓ ${eventSpec.title} (${eventSpec.recordings.length} recordings${eventSpec.primaryRecording ? ", primary set" : ", no primary"})`
      );
    }

    // 9. Create test notifications for direct users with catalog access
    // Note: Invited users get notifications after they log in via OAuth flow
    console.log("\n[9/9] Creating test notifications...");
    let notificationsCreated = 0;

    // Create notifications for users who have catalog access
    // Direct users don't have CatalogAccess records yet, so we create notifications
    // for the superadmin and admin who can view all catalogs
    const usersForNotifications = [
      { userId: createdUsers[TEST_USERS.superadmin.email], name: "superadmin" },
      { userId: createdUsers[TEST_USERS.admin.email], name: "admin" },
    ];

    for (const { userId, name } of usersForNotifications) {
      if (!userId) continue;

      const firstReleasedEventId = eventIdByTitle.get(TEST_EVENTS[0].title);
      const secondReleasedEventId = eventIdByTitle.get(TEST_EVENTS[2].title);
      if (!firstReleasedEventId || !secondReleasedEventId) {
        throw new Error("Released event missing for notification seeding");
      }

      // Create unread notifications for the released seeded events
      const notificationData = [
        {
          userId,
          catalogId: TEST_WORKFLOW_GROUP.id,
          eventId: firstReleasedEventId,
          title: TEST_EVENTS[0].title,
          isRead: false,
          createdAt: new Date(Date.now() - 1000 * 60 * 5), // 5 minutes ago
        },
        {
          userId,
          catalogId: TEST_WORKFLOW_GROUP.id,
          eventId: secondReleasedEventId,
          title: TEST_EVENTS[2].title,
          isRead: false,
          createdAt: new Date(Date.now() - 1000 * 60 * 10), // 10 minutes ago
        },
      ];

      for (const data of notificationData) {
        await prisma.eventNotification.upsert({
          where: {
            userId_catalogId_eventId: {
              userId: data.userId,
              catalogId: data.catalogId,
              eventId: data.eventId,
            },
          },
          update: {},
          create: data,
        });
        notificationsCreated++;
      }
      console.log(`  ✓ ${name}: 2 unread event notifications`);
    }

    console.log("\n=== E2E Test Data Seeded Successfully ===\n");
    console.log("Summary:");
    console.log(`  Direct users: ${DIRECT_USERS.length} (superadmin, admin, pending, blocked, mutation)`);
    console.log(`  Pending admissions: ${INVITED_USERS.length} (seeded for OAuth claim flow)`);
    console.log(`  Workflow Groups: 1`);
    console.log(`  Recorders: ${SEEDED_RECORDERS.length}`);
    console.log(`  Locations: ${SEEDED_LOCATIONS.length}`);
    console.log(`  Audio Metadata: ${TEST_AUDIO_FILES.length}`);
    console.log(`  Catalog Entries: ${catalogEntryCount}`);
    console.log(`  Catalog Events: ${TEST_EVENTS.length}`);
    console.log(`  Event Recordings: ${eventRecordingCount}`);
    console.log(`  Notifications: ${notificationsCreated}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Seed error:", e);
  process.exit(1);
});
