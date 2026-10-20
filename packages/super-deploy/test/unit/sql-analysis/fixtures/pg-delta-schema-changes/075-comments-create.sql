-- comments / create
-- ok=true
COMMENT ON COLUMN "public"."t"."a" IS 'col a';

COMMENT ON CONSTRAINT "t_pkey" ON "public"."t" IS 'pk';

COMMENT ON FUNCTION "public"."f"() IS 'eff';

COMMENT ON TABLE "public"."t" IS 'tee';

COMMENT ON VIEW "public"."v" IS 'vee';
