-- dep: column type change under view, index / alter
-- ok=true
DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE numeric(12,2) USING "a"::numeric(12,2);

CREATE VIEW "public"."v" AS  SELECT id,
    a,
    (a * (2)::numeric) AS a2
   FROM public.t;
