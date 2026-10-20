-- composite type / alter
-- ok=true
ALTER TYPE "public"."address" ADD ATTRIBUTE "zip" character varying(10) CASCADE;
