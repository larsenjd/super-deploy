-- generated column (stored) / alter
-- ok=true
ALTER TABLE "public"."t" DROP COLUMN "total";

ALTER TABLE "public"."t" ADD COLUMN "total" integer GENERATED ALWAYS AS ((a * b)) STORED;
