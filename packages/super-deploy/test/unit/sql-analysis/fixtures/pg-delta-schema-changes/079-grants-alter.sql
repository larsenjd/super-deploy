-- grants / alter
-- ok=true
REVOKE ALL ON TABLE "public"."t" FROM "prototype_reader";

REVOKE ALL ON TABLE "public"."v" FROM "prototype_reader";

REVOKE ALL ON FUNCTION "public"."f"() FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."f"() FROM "prototype_reader";

GRANT EXECUTE ON FUNCTION "public"."f"() TO "prototype_reader";

REVOKE ALL ("a") ON TABLE "public"."t" FROM "prototype_reader";

GRANT SELECT ("a") ON TABLE "public"."t" TO "prototype_reader";

REVOKE ALL ("id") ON TABLE "public"."t" FROM "prototype_reader";

GRANT SELECT ("id") ON TABLE "public"."t" TO "prototype_reader";

REVOKE ALL ON TABLE "public"."t" FROM "prototype_writer";

GRANT INSERT, SELECT ON TABLE "public"."t" TO "prototype_writer";
