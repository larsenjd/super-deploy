-- dep: column type change under view, index / create
-- ok=true
DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE bigint USING "a"::bigint;

CREATE VIEW "public"."v" AS  SELECT id,
    a
   FROM public.t;
