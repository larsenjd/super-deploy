-- index / alter
-- ok=true
DROP INDEX "public"."t_a_idx";

CREATE UNIQUE INDEX t_a_idx ON public.t USING btree (a, b) WHERE (b IS NOT NULL);

CREATE INDEX t_lower_b_idx ON public.t USING btree (lower(b));
