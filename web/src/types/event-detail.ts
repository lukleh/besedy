/**
 * Event detail payload of `GET /api/catalogs/{catalogId}/events/{eventId}`.
 *
 * Shared by the online event page, the download manager (which stores the
 * payload inside a completed event package), and the local content source
 * (which serves it back when the network is unavailable).
 */
export interface EventRecording {
  audioHash: string;
  isPrimary: boolean;
  sortOrder: number;
  title: string;
  artist: string | null;
  durationHms: string | null;
  verified: boolean;
  recorder: { id: number; name: string } | null;
}

export type EventArtworkStatus =
  | "none"
  | "draft-only"
  | "published"
  | "published-with-newer-drafts";

export interface EventDetailResponse {
  id: number;
  workflowGroupId: string;
  title: string | null;
  location: { id: number; name: string } | null;
  dateYear: number;
  dateMonth: number | null;
  dateDay: number | null;
  sessionIndex: number;
  sessionOrdinal: number;
  sessionCount: number;
  description: string | null;
  released: boolean;
  recordings: EventRecording[];
  canViewArtworkCandidates?: boolean;
  canManageArtwork?: boolean;
  canPublishArtwork?: boolean;
  canManageSources?: boolean;
  artworkStatus?: EventArtworkStatus;
  publishedArtwork?: {
    id: string;
    publishedAt: string;
    assets: {
      square: { bytes: number; sha256: string };
      landscape: { bytes: number; sha256: string };
    };
  } | null;
  latestDraftCandidate?: {
    id: string;
    label: string | null;
    createdAt: string;
  } | null;
}
