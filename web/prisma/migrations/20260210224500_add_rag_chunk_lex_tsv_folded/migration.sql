ALTER TABLE "rag_chunk"
ADD COLUMN "lex_tsv_folded" tsvector;

CREATE INDEX "rag_chunk_lex_tsv_folded_gin_idx"
  ON "rag_chunk"
  USING GIN ("lex_tsv_folded");
