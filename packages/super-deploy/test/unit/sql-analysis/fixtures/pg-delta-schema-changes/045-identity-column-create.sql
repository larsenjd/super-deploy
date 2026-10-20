-- identity column / create
-- ok=true
ALTER TABLE "public"."t" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY;

ALTER TABLE "public"."t" ADD CONSTRAINT "t_pkey" PRIMARY KEY (id);
