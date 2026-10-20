-- composite type / create
-- ok=true
CREATE TABLE "public"."t" ("id" integer NOT NULL, CONSTRAINT "t_pkey" PRIMARY KEY (id));

CREATE TYPE "public"."address" AS ("street" text, "city" text);

ALTER TABLE "public"."t" ADD COLUMN "addr" public.address;
