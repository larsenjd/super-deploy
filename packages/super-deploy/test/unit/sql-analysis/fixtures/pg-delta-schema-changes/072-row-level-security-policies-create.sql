-- row-level security + policies / create
-- ok=true
ALTER TABLE "public"."t" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "t_select" ON "public"."t" FOR SELECT TO PUBLIC USING ((owner = CURRENT_USER));
