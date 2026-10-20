-- generated column (stored) / create
-- ok=true
ALTER TABLE "public"."t" ADD COLUMN "total" integer GENERATED ALWAYS AS ((a + b)) STORED;
