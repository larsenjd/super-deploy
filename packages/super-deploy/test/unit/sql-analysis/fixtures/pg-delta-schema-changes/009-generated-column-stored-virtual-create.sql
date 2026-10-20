-- generated column stored -> virtual / create
-- ok=true
ALTER TABLE "public"."t" ADD COLUMN "g" integer GENERATED ALWAYS AS ((a * 2)) STORED;
