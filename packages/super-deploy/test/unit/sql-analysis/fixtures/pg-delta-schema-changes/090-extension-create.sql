-- extension / create (pg-delta 1.0.0-alpha.59 with super-deploy's differ wrapper:
-- VERSION added, COMMENT ON EXTENSION left out)
-- ok=true
CREATE EXTENSION "citext" SCHEMA "public" VERSION '1.8';

CREATE EXTENSION "pgcrypto" SCHEMA "public" VERSION '1.4';

CREATE EXTENSION "uuid-ossp" SCHEMA "public" VERSION '1.1';

CREATE TABLE "public"."users" ("id" bigint NOT NULL, "email" public.citext NOT NULL, "salt" text DEFAULT public.gen_salt('bf'::text), "u" uuid DEFAULT public.uuid_generate_v4(), CONSTRAINT "users_pkey" PRIMARY KEY (id));
