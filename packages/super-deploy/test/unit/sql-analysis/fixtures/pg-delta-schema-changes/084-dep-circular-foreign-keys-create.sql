-- dep: circular foreign keys / create
-- ok=true
CREATE TABLE "public"."customers" ("id" integer NOT NULL, "last_order_id" integer, CONSTRAINT "customers_pkey" PRIMARY KEY (id));

CREATE TABLE "public"."orders" ("id" integer NOT NULL, "customer_id" integer NOT NULL, CONSTRAINT "orders_pkey" PRIMARY KEY (id));

ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES public.customers(id);

ALTER TABLE "public"."customers" ADD CONSTRAINT "customers_last_order_fk" FOREIGN KEY (last_order_id) REFERENCES public.orders(id);
