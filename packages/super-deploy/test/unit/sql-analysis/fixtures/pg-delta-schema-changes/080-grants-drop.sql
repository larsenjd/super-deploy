-- grants / drop
-- ok=true
REVOKE ALL ON FUNCTION "public"."f"() FROM "prototype_reader";

REVOKE ALL ("a") ON TABLE "public"."t" FROM "prototype_reader";

REVOKE ALL ("id") ON TABLE "public"."t" FROM "prototype_reader";

REVOKE ALL ON TABLE "public"."t" FROM "prototype_writer";

REVOKE ALL ON FUNCTION "public"."f"() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION "public"."f"() TO PUBLIC;
