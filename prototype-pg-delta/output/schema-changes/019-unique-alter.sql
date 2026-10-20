-- unique / alter
-- ok=true
ALTER TABLE "public"."t" DROP CONSTRAINT "t_email_key";

ALTER TABLE "public"."t" ADD CONSTRAINT "t_email_key" UNIQUE NULLS NOT DISTINCT (tenant, email);
