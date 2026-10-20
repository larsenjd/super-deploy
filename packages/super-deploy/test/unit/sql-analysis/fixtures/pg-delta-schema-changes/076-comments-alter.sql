-- comments / alter
-- ok=false
COMMENT ON COLUMN "public"."t"."a" IS NULL;

COMMENT ON CONSTRAINT "t_pkey" ON "public"."t" IS NULL;

COMMENT ON VIEW "public"."v" IS NULL;

COMMENT ON COLUMN "public"."t"."b" IS 'col b';

COMMENT ON FUNCTION "public"."f"() IS 'eff 2';

COMMENT ON TABLE "public"."t" IS 'tee 2';
