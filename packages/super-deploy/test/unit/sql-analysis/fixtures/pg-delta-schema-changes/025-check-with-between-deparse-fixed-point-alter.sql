-- check with BETWEEN (deparse fixed point) / alter
-- ok=false
ALTER TABLE "public"."t" DROP CONSTRAINT "t_qty_check";

ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK ((((qty >= 0) AND (qty <= 100)) AND (ROW(qty, id) > ROW(0, 0))));

-- RE-DIFF AFTER APPLY (should be empty):
ALTER TABLE "public"."t" DROP CONSTRAINT "t_qty_check";

ALTER TABLE "public"."t" ADD CONSTRAINT "t_qty_check" CHECK ((((qty >= 0) AND (qty <= 100)) AND (ROW(qty, id) > ROW(0, 0))));
