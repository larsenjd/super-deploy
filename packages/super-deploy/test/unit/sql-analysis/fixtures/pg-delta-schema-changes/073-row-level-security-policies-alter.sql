-- row-level security + policies / alter
-- ok=true
DROP POLICY "t_select" ON "public"."t";

ALTER TABLE "public"."t" FORCE ROW LEVEL SECURITY;

CREATE POLICY "t_admin" ON "public"."t" AS RESTRICTIVE FOR DELETE TO PUBLIC USING ((CURRENT_USER = 'admin'::name));

CREATE POLICY "t_select" ON "public"."t" FOR ALL TO "prototype_reader" USING ((owner = CURRENT_USER)) WITH CHECK ((owner = CURRENT_USER));
