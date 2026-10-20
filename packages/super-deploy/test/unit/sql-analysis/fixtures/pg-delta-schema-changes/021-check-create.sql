-- check / create
-- ok=true
ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK ((qty > 0));
