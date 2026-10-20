-- dep: column type change under view, policy, index / create
-- ok=true
DROP POLICY "p" ON "public"."t";

DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE bigint USING "a"::bigint;

CREATE VIEW "public"."v" AS  SELECT id,
    a
   FROM public.t;

CREATE POLICY "p" ON "public"."t" FOR ALL TO PUBLIC USING ((a > 0));
