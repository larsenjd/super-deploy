-- dep: view chain + sql function + domain / create
-- ok=true
CREATE TABLE "public"."o" ("id" integer NOT NULL, CONSTRAINT "o_pkey" PRIMARY KEY (id));

CREATE DOMAIN "public"."amount" AS numeric(12,2) CONSTRAINT "amount_check" CHECK ((VALUE >= (0)::numeric));

ALTER TABLE "public"."o" ADD COLUMN "amt" public.amount;

CREATE OR REPLACE FUNCTION public.o_total()
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$ select sum(amt) from o $function$;

CREATE VIEW "public"."v1" AS  SELECT id,
    amt
   FROM public.o;

CREATE VIEW "public"."v2" AS  SELECT id,
    amt,
    public.o_total() AS total
   FROM public.v1;
