/*
  Warnings:

  - You are about to drop the `invitations` table. If the table is not empty, all the data it contains will be lost.

*/

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "invitations" LIMIT 1) THEN
    RAISE EXCEPTION
      'Refusing to drop legacy invitations while rows remain'
      USING HINT = 'Run scripts/retire-legacy-invitations.ts first and confirm the legacy table is empty before applying this migration.';
  END IF;
END
$$;

DROP TABLE "invitations";
