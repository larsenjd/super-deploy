-- dep: view chain + sql function + domain / drop
-- ok=true
DROP VIEW "public"."v2";

DROP VIEW "public"."v1";

DROP FUNCTION "public"."o_total"();

DROP TABLE "public"."o";

DROP DOMAIN "public"."amount";
