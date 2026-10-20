-- domain / alter
-- ok=true
ALTER DOMAIN "public"."positive_int" DROP CONSTRAINT "positive_int_check";

ALTER DOMAIN "public"."positive_int" SET DEFAULT 1;

ALTER DOMAIN "public"."positive_int" SET NOT NULL;

ALTER DOMAIN "public"."positive_int" ADD CONSTRAINT "positive_int_check" CHECK (((VALUE > 0) AND (VALUE < 1000000)));
