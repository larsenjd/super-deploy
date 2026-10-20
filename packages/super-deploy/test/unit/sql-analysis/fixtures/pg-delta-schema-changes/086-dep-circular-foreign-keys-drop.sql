-- dep: circular foreign keys / drop
-- ok=true
ALTER TABLE "public"."customers" DROP CONSTRAINT "customers_last_order_fk";

ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_customer_id_fkey";

DROP TABLE "public"."customers";

DROP TABLE "public"."orders";
