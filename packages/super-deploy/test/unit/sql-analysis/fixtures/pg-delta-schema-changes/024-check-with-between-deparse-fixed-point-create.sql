-- check with BETWEEN (deparse fixed point) / create
-- ok=true
ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK (((qty >= 1) AND (qty <= 10)));
