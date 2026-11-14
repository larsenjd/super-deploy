-- extension / update (super-deploy's differ wrapper adds UPDATE TO first;
-- pg-delta 1.0.0-alpha.59 plans nothing for a version change)
-- ok=true
ALTER EXTENSION "citext" UPDATE TO '1.8';

ALTER TABLE "public"."users" ADD COLUMN "nickname" public.citext;
