-- `transcript_fingerprint` meant two different things depending on which side
-- of the boundary you stood on. The web hashes the rendered JSON bytes, which
-- include the publication's own provenance block; the Python indexer derives
-- its fingerprint from normalized segment timing and text. Comparing one to
-- the other would have looked like a verification and been a coincidence.
--
-- They are now separate columns with separate owners. The search source
-- fingerprint stays null until real index activation exists to record it.

ALTER TABLE "transcript_publication"
RENAME COLUMN "transcript_fingerprint" TO "artifact_sha256";

ALTER TABLE "transcript_publication"
ADD COLUMN "search_source_fingerprint" VARCHAR(64);
