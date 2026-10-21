-- identity column / drop
-- ok=true
ALTER TABLE "public"."t" DROP CONSTRAINT "t_pkey";

ALTER TABLE "public"."t" ALTER COLUMN "id" DROP IDENTITY;
