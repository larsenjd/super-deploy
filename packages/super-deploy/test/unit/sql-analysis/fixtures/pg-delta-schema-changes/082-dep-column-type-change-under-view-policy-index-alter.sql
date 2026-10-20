-- dep: column type change under view, policy, index / alter
-- ok=true
DROP POLICY "p" ON "public"."t";

DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE numeric(12,2) USING "a"::numeric(12,2);

CREATE VIEW "public"."v" AS  SELECT id,
    a,
    (a * (2)::numeric) AS a2
   FROM public.t;

CREATE POLICY "p" ON "public"."t" FOR ALL TO PUBLIC USING ((a > (0)::numeric));
