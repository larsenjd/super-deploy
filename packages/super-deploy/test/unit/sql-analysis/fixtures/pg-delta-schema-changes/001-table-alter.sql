-- table / alter
-- ok=true
ALTER TABLE "public"."t" ALTER COLUMN "name" DROP DEFAULT;

ALTER TABLE "public"."t" DROP COLUMN "price";

ALTER TABLE "public"."t" ADD COLUMN "qty" integer NOT NULL DEFAULT 1;

ALTER TABLE "public"."t" ADD COLUMN "extra" jsonb;

ALTER TABLE "public"."t" ALTER COLUMN "name" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "name" TYPE character varying(200) USING "name"::character varying(200);
