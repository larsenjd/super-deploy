-- table / create
-- ok=true
CREATE TABLE "public"."t" ("id" bigint NOT NULL, "name" text NOT NULL DEFAULT 'x'::text, "price" numeric(10,2), CONSTRAINT "t_pkey" PRIMARY KEY (id));
