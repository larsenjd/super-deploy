-- dep: circular foreign keys / alter
-- ok=true
ALTER TABLE "public"."customers" DROP CONSTRAINT "customers_last_order_fk";

ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_customer_id_fkey";

ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_last_order_fk" FOREIGN KEY (last_order_id) REFERENCES public.orders(id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;
