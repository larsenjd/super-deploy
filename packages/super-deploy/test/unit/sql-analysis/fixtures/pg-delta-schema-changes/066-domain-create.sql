-- domain / create
-- ok=true
CREATE TABLE "public"."t" ("id" integer NOT NULL, CONSTRAINT "t_pkey" PRIMARY KEY (id));

CREATE DOMAIN "public"."positive_int" AS integer CONSTRAINT "positive_int_check" CHECK ((VALUE > 0));

ALTER TABLE "public"."t" ADD COLUMN "n" public.positive_int;
