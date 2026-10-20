-- row-level security + policies / drop
-- ok=true
DROP POLICY "t_admin" ON "public"."t";

DROP POLICY "t_select" ON "public"."t";

ALTER TABLE "public"."t" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "public"."t" DISABLE ROW LEVEL SECURITY;
