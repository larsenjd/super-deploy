-- check / alter
-- ok=true
ALTER TABLE "public"."t" DROP CONSTRAINT "t_qty_check";

ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK (((qty >= 0) AND (qty < 1000)));
