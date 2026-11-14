-- extension / drop (pg-delta 1.0.0-alpha.59: its users dropped first, then
-- DROP EXTENSION without CASCADE)
-- ok=true
ALTER TABLE "public"."users" DROP COLUMN "email";

DROP EXTENSION "citext";
