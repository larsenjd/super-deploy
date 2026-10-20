-- identity column / drop
-- ok=true
REVOKE ALL ON SEQUENCE "public"."t_id_seq" FROM "prototype_owner";

ALTER TABLE "public"."t" DROP CONSTRAINT "t_pkey";

ALTER TABLE "public"."t" ALTER COLUMN "id" DROP IDENTITY;
