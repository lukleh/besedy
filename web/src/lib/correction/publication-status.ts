import type { TranscriptPublicationStatus } from "@/generated/prisma/client";

/**
 * Publications that hold their workspace: pending, activating or rolling
 * back. Kept apart from the publication service so a page that only asks
 * whether one is on its way does not load rendering, storage and the index
 * client with it.
 */
export const IN_FLIGHT_PUBLICATION_STATUSES: TranscriptPublicationStatus[] = [
  "PENDING",
  "ACTIVATING",
  "ROLLING_BACK",
];
