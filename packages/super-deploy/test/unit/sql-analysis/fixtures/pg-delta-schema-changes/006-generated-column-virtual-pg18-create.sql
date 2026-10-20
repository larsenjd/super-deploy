-- generated column (virtual, PG18) / create
-- ok=false
ALTER TABLE "public"."t" ADD COLUMN "total" integer GENERATED ALWAYS AS ((a + b)) STORED;
