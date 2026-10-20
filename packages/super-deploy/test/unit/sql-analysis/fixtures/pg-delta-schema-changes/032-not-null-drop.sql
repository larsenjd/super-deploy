-- not null / drop
-- ok=true
ALTER TABLE "public"."t" ALTER COLUMN "code" DROP NOT NULL;

ALTER TABLE "public"."t" ALTER COLUMN "name" DROP NOT NULL;
