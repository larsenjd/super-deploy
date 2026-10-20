-- grants / create
-- ok=true
REVOKE ALL ON TABLE "public"."t" FROM "prototype_reader";

GRANT SELECT ON TABLE "public"."t" TO "prototype_reader";

REVOKE ALL ON TABLE "public"."v" FROM "prototype_reader";

GRANT SELECT ON TABLE "public"."v" TO "prototype_reader";
