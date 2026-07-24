/**
 * Shared E2E test data
 *
 * Single source of truth for test fixtures used by:
 * - Playwright tests
 * - Fixture generators (audio/catalog/transcripts)
 * - Prisma seed-test.ts
 */

export const TEST_CATALOG_ID = "20251225_120000";

export interface TestAudioSpec {
  shortHash: string;
  filename: string;
  duration: number; // seconds
  frequency: number; // Hz
}

export const TEST_AUDIO_SPECS: TestAudioSpec[] = [
  { shortHash: "ab00001abc", filename: "recording_001.wav", duration: 30, frequency: 440 },
  { shortHash: "ab00002def", filename: "recording_002.wav", duration: 60, frequency: 523 },
  { shortHash: "ab00003cab", filename: "recording_003.wav", duration: 10, frequency: 659 },
  { shortHash: "ab00004dab", filename: "recording_004.wav", duration: 120, frequency: 784 },
  { shortHash: "ab00005eaf", filename: "recording_005.wav", duration: 45, frequency: 880 },
];

export function padHash(shortHash: string): string {
  return shortHash.padEnd(64, "0");
}

export const TEST_AUDIO_FILES = TEST_AUDIO_SPECS.map((spec) => ({
  ...spec,
  hash: padHash(spec.shortHash),
}));

export type TestAudioFile = (typeof TEST_AUDIO_FILES)[number];

export const TEST_RECORDERS = ["Recorder A", "Recorder B"] as const;
export const TEST_LOCATIONS = ["Location X", "Location Y"] as const;

export interface TestEventSpec {
  title: string;
  location: (typeof TEST_LOCATIONS)[number];
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  description?: string;
  released: boolean;
  recordings: string[]; // shortHash list
  primaryRecording: string | null; // shortHash or null
}

export const TEST_EVENTS: TestEventSpec[] = [
  {
    title: "Spring Gathering",
    location: "Location X",
    dateYear: 2024,
    dateMonth: 3,
    dateDay: 15,
    description: "Seeded event with primary recording",
    released: true,
    recordings: ["ab00001abc", "ab00005eaf"],
    primaryRecording: "ab00005eaf",
  },
  {
    title: "City Interview Session",
    location: "Location Y",
    dateYear: 2024,
    dateMonth: 4,
    dateDay: 1,
    description: "Seeded event without a primary recording",
    released: false,
    recordings: ["ab00002def"],
    primaryRecording: null,
  },
  {
    title: "Archive Evening",
    location: "Location X",
    dateYear: 2024,
    dateMonth: 5,
    dateDay: 20,
    description: "Second released event for notification coverage",
    released: true,
    recordings: ["ab00003cab", "ab00004dab"],
    primaryRecording: "ab00004dab",
  },
];

export const TEST_USERS = {
  superadmin: { email: "superadmin@besedy.test", name: "Super Admin" },
  admin: { email: "admin@besedy.test", name: "Admin" },
  owner: { email: "owner@besedy.test", name: "Catalog Owner" },
  editor: { email: "editor@besedy.test", name: "Catalog Editor" },
  member: { email: "member@besedy.test", name: "Catalog Member" },
  viewer: { email: "viewer@besedy.test", name: "Catalog Viewer" },
  listener: { email: "listener@besedy.test", name: "Catalog Listener" },
  noaccess: { email: "noaccess@besedy.test", name: "No Access User" },
  // Dedicated user for mutation tests - never used in parallel tests
  // This avoids race conditions when mutation tests modify user access
  mutation: { email: "mutation@besedy.test", name: "Mutation Test User" },
  pending: { email: "pending@besedy.test", name: "Pending User" },
  blocked: { email: "blocked@besedy.test", name: "Blocked User" },
} as const;
