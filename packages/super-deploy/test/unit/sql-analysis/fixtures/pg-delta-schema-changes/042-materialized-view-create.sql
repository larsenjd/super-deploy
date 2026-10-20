-- materialized view / create
-- ok=true
CREATE MATERIALIZED VIEW "public"."mv" AS  SELECT a,
    count(*) AS n
   FROM public.t
  GROUP BY a;

CREATE INDEX mv_a_idx ON public.mv USING btree (a);
