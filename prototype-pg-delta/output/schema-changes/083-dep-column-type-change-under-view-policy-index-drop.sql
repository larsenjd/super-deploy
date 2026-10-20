-- dep: column type change under view, policy, index / drop
-- ok=true
DROP POLICY "p" ON "public"."t";

DROP VIEW "public"."v";

ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;

ALTER TABLE "public"."t" ALTER COLUMN "a" TYPE integer USING "a"::integer;

CREATE VIEW "public"."v" AS  SELECT id,
    a
   FROM public.t;

CREATE POLICY "p" ON "public"."t" FOR ALL TO PUBLIC USING ((a > 0));
