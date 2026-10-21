-- dep: column type change under view, index / drop
-- ok=true
DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE integer USING "a"::integer;

CREATE VIEW "public"."v" AS  SELECT id,
    a
   FROM public.t;
